const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

function requireEnv(name) {
  const v = process.env[name];
  if (!v) console.error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  return v;
}

const s3 = new S3Client({
  endpoint: requireEnv('SPACES_ENDPOINT'),
  region: process.env.SPACES_REGION,
  credentials: {
    accessKeyId: process.env.SPACES_KEY,
    secretAccessKey: process.env.SPACES_SECRET
  }
});

// Generates a short-lived URL the browser can PUT a file to directly.
function presignPutUrl(key, contentType, expiresSeconds = 300) {
  const input = {
    Bucket: process.env.SPACES_BUCKET,
    Key: key,
    ContentType: contentType
  };
  if (process.env.MEDIA_PUBLIC_READ === 'true') input.ACL = 'public-read';
  const command = new PutObjectCommand(input);
  return getSignedUrl(s3, command, { expiresIn: expiresSeconds });
}

async function uploadObject(key, contentType, body) {
  const input = {
    Bucket: process.env.SPACES_BUCKET,
    Key: key,
    ContentType: contentType,
    Body: body
  };
  if (process.env.MEDIA_PUBLIC_READ === 'true') input.ACL = 'public-read';
  await s3.send(new PutObjectCommand(input));
}

function presignGetUrl(key, expiresSeconds = 900) {
  const command = new GetObjectCommand({
    Bucket: process.env.SPACES_BUCKET,
    Key: key
  });
  return getSignedUrl(s3, command, { expiresIn: expiresSeconds });
}

function publicUrlFor(key) {
  return `${process.env.SPACES_URL}/${key}`;
}

module.exports = { s3, presignPutUrl, presignGetUrl, uploadObject, publicUrlFor };
