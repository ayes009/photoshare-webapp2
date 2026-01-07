const express = require('express');
const cors = require('cors');
const path = require('path');
const { BlobServiceClient } = require('@azure/storage-blob');

const app = express();
const PORT = process.env.PORT || 8080;

// Azure Blob Storage Configuration
const STORAGE_ACCOUNT = process.env.STORAGE_ACCOUNT || "photoshare123";
const CONTAINER_NAME = "photos";
const METADATA_CONTAINER = "metadata";
const SAS_TOKEN = process.env.SAS_TOKEN || "sv=2024-11-04&ss=b&srt=co&sp=rwdctfx&se=2026-01-07T04:01:36Z&st=2026-01-06T19:46:36Z&spr=https&sig=JzbWbKVLzdBwWMmaZ6KeG2qRLRJui%2Ft8U1On3VPbqKU%3D";
const BLOB_SERVICE_URL = `https://${STORAGE_ACCOUNT}.blob.core.windows.net`;

console.log('🚀 Starting PhotoShare server...');
console.log('📍 Port:', PORT);
console.log('💾 Storage Account:', STORAGE_ACCOUNT);

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Logging middleware
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('❌ Error:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
});

// Helper function
async function streamToString(readableStream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        readableStream.on('data', (data) => chunks.push(data.toString()));
        readableStream.on('end', () => resolve(chunks.join('')));
        readableStream.on('error', reject);
    });
}

// Get Blob Service Client
function getBlobServiceClient() {
    return new BlobServiceClient(`${BLOB_SERVICE_URL}?${SAS_TOKEN}`);
}

// Health check
app.get('/health', (req, res) => {
    console.log('✅ Health check requested');
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        port: PORT,
        storage: STORAGE_ACCOUNT
    });
});

// Get all photos
app.get('/api/photos', async (req, res) => {
    try {
        console.log('📸 Fetching all photos...');
        const blobServiceClient = getBlobServiceClient();
        const metadataContainer = blobServiceClient.getContainerClient(METADATA_CONTAINER);

        const photos = [];
        
        // Check if container exists
        const containerExists = await metadataContainer.exists();
        if (!containerExists) {
            console.log('⚠️ Metadata container does not exist, returning empty array');
            return res.json([]);
        }

        for await (const blob of metadataContainer.listBlobsFlat()) {
            if (blob.name.endsWith('.json')) {
                try {
                    const blobClient = metadataContainer.getBlobClient(blob.name);
                    const downloadResponse = await blobClient.download();
                    const photoData = await streamToString(downloadResponse.readableStreamBody);
                    photos.push(JSON.parse(photoData));
                } catch (blobError) {
                    console.error('❌ Error reading blob:', blob.name, blobError);
                }
            }
        }

        photos.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
        console.log(`✅ Found ${photos.length} photos`);
        res.json(photos);
    } catch (error) {
        console.error('❌ Error fetching photos:', error);
        res.status(500).json({ error: 'Failed to fetch photos', details: error.message });
    }
});

// Upload photo
app.post('/api/photos', async (req, res) => {
    try {
        console.log('📤 Upload photo request received');
        const { title, caption, location, tags, imageData, fileName } = req.body;

        if (!title || !imageData || !fileName) {
            console.log('⚠️ Missing required fields');
            return res.status(400).json({ error: 'Title, imageData, and fileName required' });
        }

        const photoId = Date.now().toString();
        const blobName = `${photoId}-${fileName}`;

        console.log(`📷 Uploading photo: ${blobName}`);
        const blobServiceClient = getBlobServiceClient();
        
        // Upload image
        const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);

        const base64Data = imageData.split(',')[1];
        const buffer = Buffer.from(base64Data, 'base64');

        await blockBlobClient.upload(buffer, buffer.length, {
            blobHTTPHeaders: { blobContentType: 'image/jpeg' }
        });

        const imageUrl = `${BLOB_SERVICE_URL}/${CONTAINER_NAME}/${blobName}?${SAS_TOKEN}`;

        // Create metadata
        const photo = {
            id: photoId,
            title,
            caption: caption || '',
            location: location || '',
            tags: tags || '',
            url: imageUrl,
            likes: 0,
            comments: [],
            rating: 0,
            ratingCount: 0,
            uploadedAt: new Date().toISOString()
        };

        // Save metadata
        const metadataContainer = blobServiceClient.getContainerClient(METADATA_CONTAINER);
        const metadataBlobClient = metadataContainer.getBlockBlobClient(`${photoId}.json`);
        await metadataBlobClient.upload(
            JSON.stringify(photo),
            JSON.stringify(photo).length,
            { blobHTTPHeaders: { blobContentType: 'application/json' } }
        );

        console.log(`✅ Photo uploaded successfully: ${photoId}`);
        res.status(201).json(photo);
    } catch (error) {
        console.error('❌ Error uploading photo:', error);
        res.status(500).json({ error: 'Failed to upload photo', details: error.message });
    }
});

// Delete photo
app.delete('/api/photos/:photoId', async (req, res) => {
    try {
        const { photoId } = req.params;
        console.log(`🗑️ Delete photo request: ${photoId}`);
        
        const blobServiceClient = getBlobServiceClient();

        const metadataContainer = blobServiceClient.getContainerClient(METADATA_CONTAINER);
        const metadataBlobClient = metadataContainer.getBlobClient(`${photoId}.json`);

        const exists = await metadataBlobClient.exists();
        if (!exists) {
            console.log(`⚠️ Photo not found: ${photoId}`);
            return res.status(404).json({ error: 'Photo not found' });
        }

        const downloadResponse = await metadataBlobClient.download();
        const photoData = await streamToString(downloadResponse.readableStreamBody);
        const photo = JSON.parse(photoData);

        const urlParts = photo.url.split('/');
        const blobNameWithParams = urlParts[urlParts.length - 1];
        const blobName = blobNameWithParams.split('?')[0];

        const photoContainer = blobServiceClient.getContainerClient(CONTAINER_NAME);
        const imageBlobClient = photoContainer.getBlobClient(blobName);
        await imageBlobClient.delete();
        await metadataBlobClient.delete();

        console.log(`✅ Photo deleted successfully: ${photoId}`);
        res.json({ message: 'Photo deleted successfully', photoId });
    } catch (error) {
        console.error('❌ Error deleting photo:', error);
        res.status(500).json({ error: 'Failed to delete photo', details: error.message });
    }
});

// Like photo
app.post('/api/photos/:photoId/like', async (req, res) => {
    try {
        const { photoId } = req.params;
        console.log(`❤️ Like photo request: ${photoId}`);
        
        const blobServiceClient = getBlobServiceClient();

        const metadataContainer = blobServiceClient.getContainerClient(METADATA_CONTAINER);
        const metadataBlobClient = metadataContainer.getBlobClient(`${photoId}.json`);

        const downloadResponse = await metadataBlobClient.download();
        const photoData = await streamToString(downloadResponse.readableStreamBody);
        const photo = JSON.parse(photoData);

        photo.likes++;

        await metadataBlobClient.upload(
            JSON.stringify(photo),
            JSON.stringify(photo).length,
            { blobHTTPHeaders: { blobContentType: 'application/json' } }
        );

        console.log(`✅ Photo liked: ${photoId} (total likes: ${photo.likes})`);
        res.json({ success: true, likes: photo.likes });
    } catch (error) {
        console.error('❌ Error liking photo:', error);
        res.status(500).json({ error: 'Failed to like photo', details: error.message });
    }
});

// Rate photo
app.post('/api/photos/:photoId/rate', async (req, res) => {
    try {
        const { photoId } = req.params;
        const { rating } = req.body;
        console.log(`⭐ Rate photo request: ${photoId} (rating: ${rating})`);

        if (!rating || rating < 1 || rating > 5) {
            console.log('⚠️ Invalid rating');
            return res.status(400).json({ error: 'Rating must be between 1 and 5' });
        }

        const blobServiceClient = getBlobServiceClient();
        const metadataContainer = blobServiceClient.getContainerClient(METADATA_CONTAINER);
        const metadataBlobClient = metadataContainer.getBlobClient(`${photoId}.json`);

        const downloadResponse = await metadataBlobClient.download();
        const photoData = await streamToString(downloadResponse.readableStreamBody);
        const photo = JSON.parse(photoData);

        const newRatingCount = photo.ratingCount + 1;
        photo.rating = ((photo.rating * photo.ratingCount) + rating) / newRatingCount;
        photo.ratingCount = newRatingCount;

        await metadataBlobClient.upload(
            JSON.stringify(photo),
            JSON.stringify(photo).length,
            { blobHTTPHeaders: { blobContentType: 'application/json' } }
        );

        console.log(`✅ Photo rated: ${photoId} (avg: ${photo.rating.toFixed(2)})`);
        res.json({ success: true, rating: photo.rating, ratingCount: photo.ratingCount });
    } catch (error) {
        console.error('❌ Error rating photo:', error);
        res.status(500).json({ error: 'Failed to rate photo', details: error.message });
    }
});

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Catch all other routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
    console.log('');
    console.log('═══════════════════════════════════════════');
    console.log('✅ PhotoShare Server Running!');
    console.log('═══════════════════════════════════════════');
    console.log(`📍 URL: http://localhost:${PORT}`);
    console.log(`💾 Storage: ${STORAGE_ACCOUNT}`);
    console.log(`🕒 Started: ${new Date().toLocaleString()}`);
    console.log('═══════════════════════════════════════════');
    console.log('');
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
});
