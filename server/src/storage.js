// 存储驱动:local(默认,本地磁盘)/ s3(S3 兼容对象存储:Cloudflare R2 / MinIO / AWS)
// 切换:OFFICELINE_STORAGE=s3 + OFFICELINE_S3_ENDPOINT/BUCKET/KEY/SECRET(REGION 默认 auto)
// 对象键格式:files/<fileId>/v<N><ext>
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ---------- 本地磁盘驱动 ----------
function localDriver(baseDir) {
  const p = (key) => path.join(baseDir, key);
  return {
    name: 'local',
    async put(key, buf) {
      fs.mkdirSync(path.dirname(p(key)), { recursive: true });
      fs.writeFileSync(p(key), buf);
    },
    async get(key) {
      if (!fs.existsSync(p(key))) return null;
      return fs.readFileSync(p(key));
    },
    async exists(key) { return fs.existsSync(p(key)); },
  };
}

// ---------- S3 兼容驱动(零依赖,SigV4 签名) ----------
function s3Driver({ endpoint, bucket, accessKey, secretKey, region = 'auto' }) {
  const host = new URL(endpoint).host;
  const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest();
  const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');

  function sign(method, key, body) {
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
    const date = amzDate.slice(0, 8);
    const payloadHash = sha256hex(body || '');
    const uri = `/${bucket}/${key}`;
    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = [method, uri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${date}/${region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
    let k = hmac(`AWS4${secretKey}`, date);
    k = hmac(k, region); k = hmac(k, 's3'); k = hmac(k, 'aws4_request');
    const signature = hmac(k, stringToSign).toString('hex');
    return {
      url: `${endpoint}${uri}`,
      headers: {
        'x-amz-date': amzDate,
        'x-amz-content-sha256': payloadHash,
        authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
    };
  }

  async function req(method, key, body) {
    const { url, headers } = sign(method, key, body);
    const r = await fetch(url, { method, headers, body });
    return r;
  }

  return {
    name: 's3',
    async put(key, buf) {
      const r = await req('PUT', key, buf);
      if (!r.ok) throw new Error(`S3 PUT ${key} 失败: ${r.status} ${(await r.text()).slice(0, 200)}`);
    },
    async get(key) {
      const r = await req('GET', key);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`S3 GET ${key} 失败: ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    },
    async exists(key) {
      const r = await req('HEAD', key);
      return r.ok;
    },
  };
}

function createStorage(env, localBase) {
  if ((env.OFFICELINE_STORAGE || 'local') === 's3') {
    for (const k of ['OFFICELINE_S3_ENDPOINT', 'OFFICELINE_S3_BUCKET', 'OFFICELINE_S3_KEY', 'OFFICELINE_S3_SECRET']) {
      if (!env[k]) throw new Error(`使用 s3 存储必须设置 ${k}`);
    }
    return s3Driver({
      endpoint: env.OFFICELINE_S3_ENDPOINT.replace(/\/$/, ''),
      bucket: env.OFFICELINE_S3_BUCKET,
      accessKey: env.OFFICELINE_S3_KEY,
      secretKey: env.OFFICELINE_S3_SECRET,
      region: env.OFFICELINE_S3_REGION || 'auto',
    });
  }
  return localDriver(localBase);
}

module.exports = { createStorage };
