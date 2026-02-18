import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

let s3: S3Client;
let bucketName: string;
let publicUrl: string;

export function initR2(config: {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  publicUrl: string;
}): void {
  s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  bucketName = config.bucketName;
  publicUrl = config.publicUrl.replace(/\/$/, '');
}

export async function uploadAttachment(
  discordUrl: string,
  channelId: string,
  messageId: string,
  filename: string
): Promise<string> {
  const res = await fetch(discordUrl);
  if (!res.ok) throw new Error(`Failed to fetch attachment: ${res.status} ${discordUrl}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
  const key = `attachments/${channelId}/${messageId}/${filename}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );

  return `${publicUrl}/${key}`;
}

export function getAttachmentType(
  contentType: string,
  filename: string
): 'image' | 'video' | 'audio' | 'file' {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';

  const ext = filename.toLowerCase().split('.').pop();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext ?? '')) return 'image';
  if (['mp4', 'mov', 'avi', 'webm'].includes(ext ?? '')) return 'video';
  if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext ?? '')) return 'audio';

  return 'file';
}
