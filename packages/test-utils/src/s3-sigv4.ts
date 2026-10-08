import { createHash, createHmac } from "node:crypto";

/**
 * Minimal AWS Signature Version 4 signer for a single-object PUT/GET
 * against an S3-compatible endpoint (SeaweedFS's S3 gateway, configured
 * with docker/storage/s3-identities.json — see docker-compose.yml). This
 * implements only what the disposable smoke test needs: a single,
 * non-chunked PUT and a plain GET, path-style, no query-string signing,
 * no multipart upload.
 *
 * IMPORTANT: built from the documented SigV4 algorithm (canonical request
 * -> string to sign -> derived signing key) using only Node's built-in
 * `crypto` — it has NOT been executed against a real S3-compatible
 * server in this environment (no Docker was available when this was
 * written; see the final report for this sub-issue). Verify it end to
 * end the first time Docker is available here, and adjust the header
 * set/canonicalization below if the signature is rejected.
 */

export interface S3Credentials {
  accessKey: string;
  secretKey: string;
}

export interface S3ObjectTarget {
  /** e.g. "http://localhost:8333" — the S3 gateway's own origin, no path. */
  endpoint: string;
  bucket: string;
  key: string;
  region?: string;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function amzDateStamp(date: Date): { amzDate: string; dateStamp: string } {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function deriveSigningKey(secretKey: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

export function signS3Request(
  method: "PUT" | "GET",
  target: S3ObjectTarget,
  credentials: S3Credentials,
  body: Buffer = Buffer.alloc(0),
  now: Date = new Date(),
): SignedRequest {
  const region = target.region ?? "us-east-1";
  const service = "s3";
  const endpointUrl = new URL(target.endpoint);
  const host = endpointUrl.host;
  // No trailing slash when `key` is empty (a bucket-level operation,
  // e.g. createBucket below) — `/bucket/` is a different resource than
  // `/bucket` for some S3-compatible servers.
  const canonicalUri = (target.key ? `/${target.bucket}/${target.key}` : `/${target.bucket}`).replace(/\/{2,}/g, "/");
  const payloadHash = sha256Hex(body);
  const { amzDate, dateStamp } = amzDateStamp(now);

  const canonicalHeadersMap: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const signedHeaderNames = Object.keys(canonicalHeadersMap).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${canonicalHeadersMap[name]}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");

  const signingKey = deriveSigningKey(credentials.secretKey, dateStamp, region, service);
  const signature = hmac(signingKey, stringToSign).toString("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url: `${endpointUrl.origin}${canonicalUri}`,
    headers: {
      Host: host,
      "X-Amz-Date": amzDate,
      "X-Amz-Content-Sha256": payloadHash,
      Authorization: authorization,
    },
  };
}

/**
 * `PUT /<bucket>` with no key and no body — the standard S3 bucket-creation
 * request. Verified necessary-or-not by direct inspection against a real
 * SeaweedFS instance: its S3 gateway auto-vivifies a bucket on the first
 * object PUT even without this call, but this is still issued
 * explicitly (disposable-bucket setup, not relying on that
 * server-specific convenience) so the round-trip does not depend on
 * auto-vivification behavior that is not part of the S3 API contract.
 */
export async function createBucket(target: Pick<S3ObjectTarget, "endpoint" | "bucket" | "region">, credentials: S3Credentials): Promise<Response> {
  const { url, headers } = signS3Request("PUT", { ...target, key: "" }, credentials);
  return fetch(url, { method: "PUT", headers });
}

export async function putS3Object(target: S3ObjectTarget, credentials: S3Credentials, body: Buffer): Promise<Response> {
  const { url, headers } = signS3Request("PUT", target, credentials, body);
  return fetch(url, { method: "PUT", headers, body });
}

export async function getS3Object(target: S3ObjectTarget, credentials: S3Credentials): Promise<Response> {
  const { url, headers } = signS3Request("GET", target, credentials);
  return fetch(url, { method: "GET", headers });
}
