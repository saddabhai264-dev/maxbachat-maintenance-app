const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

function requireEnv(name) {
  const v = cleanEnv(name);
  if (!v) console.error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  return v;
}

function cleanEnv(name) {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : value;
}

const REQUIRED_STORAGE_ENV = [
  'SPACES_ENDPOINT',
  'SPACES_REGION',
  'SPACES_KEY',
  'SPACES_SECRET',
  'SPACES_BUCKET',
  'SPACES_URL'
];

function validateStorageConfig() {
  const missing = REQUIRED_STORAGE_ENV.filter(name => !cleanEnv(name));
  if (missing.length) {
    const err = new Error(`Storage upload config missing: ${missing.join(', ')}`);
    err.code = 'STORAGE_CONFIG_MISSING';
    throw err;
  }
}

function createS3Client() {
  validateStorageConfig();
  return new S3Client({
    endpoint: requireEnv('SPACES_ENDPOINT'),
    region: cleanEnv('SPACES_REGION'),
    credentials: {
      accessKeyId: cleanEnv('SPACES_KEY'),
      secretAccessKey: cleanEnv('SPACES_SECRET')
    }
  });
}

// Generates a short-lived URL the browser can PUT a file to directly.
function presignPutUrl(key, contentType, expiresSeconds = 300) {
  validateStorageConfig();
  const input = {
    Bucket: process.env.SPACES_BUCKET,
    Key: key,
    ContentType: contentType
  };
  if (process.env.MEDIA_PUBLIC_READ === 'true') input.ACL = 'public-read';
  const command = new PutObjectCommand(input);
  return getSignedUrl(createS3Client(), command, { expiresIn: expiresSeconds });
}

async function uploadObject(key, contentType, body) {
  validateStorageConfig();
  const input = {
    Bucket: process.env.SPACES_BUCKET,
    Key: key,
    ContentType: contentType,
    Body: body
  };
  if (process.env.MEDIA_PUBLIC_READ === 'true') input.ACL = 'public-read';
  await createS3Client().send(new PutObjectCommand(input));
}

function presignGetUrl(key, expiresSeconds = 900) {
  validateStorageConfig();
  const command = new GetObjectCommand({
    Bucket: process.env.SPACES_BUCKET,
    Key: key
  });
  return getSignedUrl(createS3Client(), command, { expiresIn: expiresSeconds });
}

function publicUrlFor(key) {
  validateStorageConfig();
  return `${cleanEnv('SPACES_URL').replace(/\/$/, '')}/${key}`;
}

module.exports = { presignPutUrl, presignGetUrl, uploadObject, publicUrlFor, validateStorageConfig };
