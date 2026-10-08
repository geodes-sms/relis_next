import { createHash, createHmac } from "node:crypto";

/**
 * Minimal AWS Signature Version 4 signer for a single-object PUT/GET
 * against an S3-compatible endpoint (SeaweedFS's S3 gateway, configured
 * with docker/storage/s3-identities.json — see docker-compose.yml). This
 * implements only what the disposable smoke test needs: a single,
 * non-chunked PUT and a plain GET, path-style, no query-string signing,
 * no multipart upload.
 *
 * Built from the documented SigV4 algorithm (canonical request -> string
 * to sign -> derived signing key) using only Node's built-in `crypto`.
 * Originally written with no Docker available, and since **verified by
 * real execution** against the live `storage` container: a signed
 * createBucket + PUT + GET round-trip succeeds byte-for-byte (sub-issue
 * #47), and sub-issue #48's persistence check reuses the same signed
 * operations across container stop/start, recreation, and reset. The
 * header set and canonicalization below needed no adjustment.
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

export interface S3ErrorResponse {
  status: number;
  /** The parsed `<Code>` of an S3-compatible XML error body (e.g. "NoSuchKey"), or `undefined` when the body isn't one. */
  code: string | undefined;
  message: string | undefined;
}

/**
 * Parses an S3-compatible XML error body's `<Code>` and `<Message>`.
 * Pure string parsing — no network, no Response object — so it can be
 * unit-tested directly with synthetic bodies (a real NoSuchKey/
 * NoSuchBucket body, an AccessDenied body, an empty body, HTML from an
 * unrelated proxy error, etc.), without any real S3-compatible server.
 * Returns `{ code: undefined, message: undefined }` for a body that
 * isn't a recognizable S3 XML error, rather than throwing — a caller
 * must decide what an unparseable body means for its own claim (see
 * `isS3ObjectAbsent`, which treats "no recognizable Code" as NOT proof
 * of absence).
 */
export function parseS3ErrorBody(xml: string): { code: string | undefined; message: string | undefined } {
  const codeMatch = /<Code>([^<]*)<\/Code>/.exec(xml);
  const messageMatch = /<Message>([^<]*)<\/Message>/.exec(xml);
  return { code: codeMatch?.[1], message: messageMatch?.[1] };
}

/**
 * Reads `response`'s status and (if present) its parsed S3 XML error
 * body into one plain, inspectable value — the shape a test asserts on
 * directly, rather than re-deriving status/code checks inline at each
 * call site.
 */
export async function readS3ErrorResponse(response: Response): Promise<S3ErrorResponse> {
  const body = await response.text().catch(() => "");
  const { code, message } = parseS3ErrorBody(body);
  return { status: response.status, code, message };
}

/**
 * True exactly when `info` is the SPECIFIC "this object/bucket is
 * genuinely absent" S3 response: HTTP 404 together with an S3 error
 * `Code` of `NoSuchKey` or `NoSuchBucket`. Pure — operates on the
 * already-parsed `S3ErrorResponse`, so it is independently
 * unit-testable with constructed fakes.
 *
 * Deliberately narrower than "status >= 400": an authentication failure
 * (401/403, e.g. AccessDenied or SignatureDoesNotMatch), a server error
 * (5xx), or a response with no parseable `Code` at all must NEVER read
 * as "the object was deleted" — each of those means something else
 * entirely (a bad credential, a server fault, a malformed request), and
 * accepting any of them as deletion evidence would let a broken check
 * or a broken server masquerade as a successful reset.
 */
export function isS3ObjectAbsent(info: S3ErrorResponse): boolean {
  return info.status === 404 && (info.code === "NoSuchKey" || info.code === "NoSuchBucket");
}
