import { sha256 } from './storage-import.mjs';

export function validateAudioFiles(files, id) {
  if (!Array.isArray(files) || !files.length || files.length > 8) throw new Error('invalid_files');
  let total = 0;
  const version=files[0]?.delivery_version??0;
  if(!Number.isInteger(version)||version<0)throw new Error('invalid_files');
  for (const [position, file] of files.entries()) {
    const suffix = file.mime_type === 'audio/wav' ? 'wav' : 'mp3';
    if (file.file_index !== position + 1 || !['audio/mpeg', 'audio/mp3', 'audio/wav'].includes(file.mime_type)
      || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isInteger(file.byte_length)
      || file.byte_length < 1 || file.byte_length > 67108864 || file.bucket_id !== 'nosayeon-audio'
      || (file.delivery_version??0)!==version
      || file.storage_path !== `${id}/${version?`revisions/${version}/`:''}original/${file.file_index}-${file.sha256}.${suffix}`) throw new Error('invalid_files');
    total += file.byte_length;
  }
  if (total > 67108864) throw new Error('invalid_files');
  return files;
}

export function validateCleanupFiles(files,id){
  if(!Array.isArray(files)||!files.length||files.length>16)throw new Error('invalid_files');
  const groups=new Map();
  for(const file of files){const version=file.delivery_version??0;if(!groups.has(version))groups.set(version,[]);groups.get(version).push(file);}
  if(groups.size>2)throw new Error('invalid_files');
  for(const group of groups.values())validateAudioFiles(group.sort((a,b)=>a.file_index-b.file_index),id);
  return files;
}

export async function readVerifiedAudio(backend, file) {
  const bytes = await backend.download(file.storage_path);
  if (!bytes || bytes.byteLength !== file.byte_length || await sha256(bytes) !== file.sha256) throw new Error('content_mismatch');
  return bytes;
}

// ZIP STORE: no compression or external runtime dependency. All names originate
// here, never from a caller. At most eight entries and 64 MiB of original audio.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function buildAudioDownload(files, contents) {
  if (contents.length !== files.length || files.some((file, i) => contents[i].byteLength !== file.byte_length)) throw new Error('invalid_audio');
  if (files.length === 1) return { bytes: contents[0], mime: files[0].mime_type,
    filename: `nosayeon.${files[0].mime_type === 'audio/wav' ? 'wav' : 'mp3'}` };
  const local = [], central = [];
  let offset = 0, centralSize = 0;
  for (const [index, file] of files.entries()) {
    const data = contents[index];
    const name = new TextEncoder().encode(`original-${index + 1}.${file.mime_type === 'audio/wav' ? 'wav' : 'mp3'}`);
    const crc = crc32(data);
    const header = new Uint8Array(30 + name.length), h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(12, 33, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true);
    header.set(name, 30); local.push(header, data);
    const directory = new Uint8Array(46 + name.length), d = new DataView(directory.buffer);
    d.setUint32(0, 0x02014b50, true); d.setUint16(4, 20, true); d.setUint16(6, 20, true); d.setUint16(14, 33, true);
    d.setUint32(16, crc, true); d.setUint32(20, data.length, true); d.setUint32(24, data.length, true);
    d.setUint16(28, name.length, true); d.setUint32(42, offset, true); directory.set(name, 46);
    central.push(directory); centralSize += directory.length; offset += header.length + data.length;
  }
  const end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, centralSize, true); e.setUint32(16, offset, true);
  const bytes = new Uint8Array(offset + centralSize + end.length);
  let position = 0;
  for (const part of [...local, ...central, end]) { bytes.set(part, position); position += part.length; }
  return { bytes, mime: 'application/zip', filename: 'nosayeon.zip' };
}
