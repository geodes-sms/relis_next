import { describe, expect, it } from "vitest";
import {
  ConfigValidationError,
  loadApiConfig,
  loadDatabaseConfig,
  loadWebRuntimeConfig,
  loadWorkerConfig,
} from "@relis/config";
import { parsePublicWebConfig } from "@relis/config/public";

// Exercises the shared @relis/config contract's public API directly
// (in-process, no child process) against valid/missing/malformed input for
// every process schema. Real process-boundary behavior (fail before
// listening, safe diagnostics on stderr) is covered by the *-startup.test.ts
// files in this directory, which spawn the actual built entry points.

const SECRET_SENTINEL = "s3cr3t-should-never-leak";

describe("@relis/config api schema", () => {
  it("accepts a complete valid environment", () => {
    const config = loadApiConfig({
      NODE_ENV: "production",
      API_PORT: "4000",
      API_HOST: "127.0.0.1",
      API_CORS_ORIGIN: "https://relis.example",
    });
    expect(config).toEqual({
      NODE_ENV: "production",
      API_PORT: 4000,
      API_HOST: "127.0.0.1",
      API_CORS_ORIGIN: "https://relis.example",
    });
  });

  it("applies documented safe defaults when everything is absent", () => {
    const config = loadApiConfig({});
    expect(config).toEqual({
      NODE_ENV: "development",
      API_PORT: 3001,
      API_HOST: "0.0.0.0",
      API_CORS_ORIGIN: "http://localhost:3000",
    });
  });

  it("rejects an out-of-range port instead of falling back to the default", () => {
    expect(() => loadApiConfig({ API_PORT: "70000" })).toThrow(ConfigValidationError);
  });

  it("rejects a non-numeric port", () => {
    try {
      loadApiConfig({ API_PORT: "not-a-number" });
      expect.unreachable("expected loadApiConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const diagnostic = (error as ConfigValidationError).toDiagnostic();
      expect(diagnostic.code).toBe("CONFIG_INVALID");
      expect(diagnostic.categories).toEqual(["network"]);
      expect(diagnostic.variables).toEqual(["API_PORT"]);
      expect(JSON.stringify(diagnostic)).not.toContain("not-a-number");
    }
  });

  it("rejects a wildcard CORS origin", () => {
    expect(() => loadApiConfig({ API_CORS_ORIGIN: "*" })).toThrow(ConfigValidationError);
  });

  it("rejects a CORS origin carrying embedded credentials", () => {
    expect(() => loadApiConfig({ API_CORS_ORIGIN: "http://user:pass@localhost:3000" })).toThrow(
      ConfigValidationError,
    );
  });

  it("rejects a CORS origin with a path", () => {
    expect(() => loadApiConfig({ API_CORS_ORIGIN: "http://localhost:3000/app" })).toThrow(ConfigValidationError);
  });

  it("rejects an empty required-looking value instead of silently defaulting", () => {
    expect(() => loadApiConfig({ API_CORS_ORIGIN: "not-a-url" })).toThrow(ConfigValidationError);
  });

  it("never echoes a secret-looking supplied value in its diagnostic", () => {
    try {
      loadApiConfig({ API_CORS_ORIGIN: `http://${SECRET_SENTINEL}@localhost:3000` });
      expect.unreachable("expected loadApiConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(JSON.stringify((error as ConfigValidationError).toDiagnostic())).not.toContain(SECRET_SENTINEL);
      expect((error as Error).message).not.toContain(SECRET_SENTINEL);
    }
  });

  it.each(["0.0.0.0", "127.0.0.1", "localhost", "::1", "relis-api.internal"])(
    "accepts the valid hostname %s",
    (host) => {
      expect(loadApiConfig({ API_HOST: host }).API_HOST).toBe(host);
    },
  );

  it("rejects a URL (scheme) as API_HOST instead of a bare hostname", () => {
    expect(() => loadApiConfig({ API_HOST: "http://localhost:3001" })).toThrow(ConfigValidationError);
  });

  it("rejects an API_HOST carrying embedded credentials, without leaking the sentinel", () => {
    try {
      loadApiConfig({ API_HOST: `${SECRET_SENTINEL}@localhost` });
      expect.unreachable("expected loadApiConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const diagnostic = (error as ConfigValidationError).toDiagnostic();
      expect(diagnostic.categories).toEqual(["network"]);
      expect(diagnostic.variables).toEqual(["API_HOST"]);
      expect(JSON.stringify(diagnostic)).not.toContain(SECRET_SENTINEL);
    }
  });

  it("rejects an API_HOST containing a path", () => {
    expect(() => loadApiConfig({ API_HOST: "localhost/admin" })).toThrow(ConfigValidationError);
  });

  it("rejects an API_HOST containing whitespace", () => {
    expect(() => loadApiConfig({ API_HOST: "local host" })).toThrow(ConfigValidationError);
  });

  it("rejects an out-of-range IPv4-looking API_HOST octet", () => {
    expect(() => loadApiConfig({ API_HOST: "999.0.0.1" })).toThrow(ConfigValidationError);
  });

  it.each([
    "::1",
    "fe80::1",
    "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
    "2001:db8:85a3::8a2e:370:7334",
    "::ffff:127.0.0.1",
    "::",
  ])("accepts the structurally valid IPv6 address %s", (host) => {
    expect(loadApiConfig({ API_HOST: host }).API_HOST).toBe(host);
  });

  it.each(["::::", "1:2", "12345::1", "gggg::1", ":::1", "1:2:3:4:5:6:7:8:9"])(
    "rejects the malformed IPv6-looking address %s (structural validation, not a character-only check)",
    (host) => {
      expect(() => loadApiConfig({ API_HOST: host })).toThrow(ConfigValidationError);
    },
  );
});

describe("@relis/config worker schema", () => {
  it("accepts a valid environment", () => {
    expect(loadWorkerConfig({ NODE_ENV: "test" })).toEqual({ NODE_ENV: "test" });
  });

  it("defaults NODE_ENV to development when absent", () => {
    expect(loadWorkerConfig({})).toEqual({ NODE_ENV: "development" });
  });

  it("rejects an invalid NODE_ENV value", () => {
    expect(() => loadWorkerConfig({ NODE_ENV: "bogus" })).toThrow(ConfigValidationError);
  });
});

describe("@relis/config web schemas (runtime + public)", () => {
  it("accepts a valid runtime port", () => {
    expect(loadWebRuntimeConfig({ WEB_PORT: "3000" })).toEqual({ WEB_PORT: 3000 });
  });

  it("defaults WEB_PORT to 3000 when absent", () => {
    expect(loadWebRuntimeConfig({})).toEqual({ WEB_PORT: 3000 });
  });

  it("rejects a non-numeric WEB_PORT", () => {
    expect(() => loadWebRuntimeConfig({ WEB_PORT: "abc" })).toThrow(ConfigValidationError);
  });

  it("accepts a valid public API URL", () => {
    expect(parsePublicWebConfig({ NEXT_PUBLIC_API_URL: "https://api.relis.example" })).toEqual({
      NEXT_PUBLIC_API_URL: "https://api.relis.example",
    });
  });

  it("defaults NEXT_PUBLIC_API_URL to the local API when absent", () => {
    expect(parsePublicWebConfig({})).toEqual({ NEXT_PUBLIC_API_URL: "http://localhost:3001" });
  });

  it("rejects a public API URL with embedded credentials", () => {
    expect(() => parsePublicWebConfig({ NEXT_PUBLIC_API_URL: "http://user:pass@api.relis.example" })).toThrow();
  });

  it("rejects a non-http(s) protocol for the public API URL", () => {
    expect(() => parsePublicWebConfig({ NEXT_PUBLIC_API_URL: "ftp://api.relis.example" })).toThrow();
  });
});

describe("@relis/config database schema (reusable contract; no real consumer yet)", () => {
  it("rejects a missing DATABASE_URL", () => {
    expect(() => loadDatabaseConfig({})).toThrow(ConfigValidationError);
  });

  it("rejects an empty DATABASE_URL", () => {
    expect(() => loadDatabaseConfig({ DATABASE_URL: "" })).toThrow(ConfigValidationError);
  });

  it("rejects a malformed connection string", () => {
    expect(() => loadDatabaseConfig({ DATABASE_URL: "not-a-connection-string" })).toThrow(ConfigValidationError);
  });

  it("rejects a non-Postgres protocol", () => {
    expect(() => loadDatabaseConfig({ DATABASE_URL: "mysql://user:pass@localhost:3306/db" })).toThrow(
      ConfigValidationError,
    );
  });

  it("accepts a well-formed postgres:// connection string", () => {
    const config = loadDatabaseConfig({
      DATABASE_URL: `postgresql://user:${SECRET_SENTINEL}@localhost:5432/relis`,
    });
    expect(config.DATABASE_URL).toContain("localhost:5432/relis");
  });

  it("never echoes the secret connection string in a rejection diagnostic", () => {
    try {
      loadDatabaseConfig({ DATABASE_URL: `mysql://user:${SECRET_SENTINEL}@localhost/db` });
      expect.unreachable("expected loadDatabaseConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const diagnostic = (error as ConfigValidationError).toDiagnostic();
      expect(diagnostic.categories).toEqual(["database"]);
      expect(JSON.stringify(diagnostic)).not.toContain(SECRET_SENTINEL);
    }
  });
});

describe("explicit empty/whitespace values are rejected, never silently defaulted", () => {
  // A variable that is ABSENT uses its documented safe default (covered by
  // the "defaults ... when absent" tests above). A variable that IS
  // present but empty or whitespace-only is a different, invalid, explicit
  // value and must be rejected — not quietly replaced by that default.

  it.each(["", " ", "\t"])("rejects API_PORT explicitly set to %j", (value) => {
    expect(() => loadApiConfig({ API_PORT: value })).toThrow(ConfigValidationError);
  });

  it.each(["", " "])("rejects API_HOST explicitly set to %j", (value) => {
    expect(() => loadApiConfig({ API_HOST: value })).toThrow(ConfigValidationError);
  });

  it.each(["", " "])("rejects API_CORS_ORIGIN explicitly set to %j", (value) => {
    expect(() => loadApiConfig({ API_CORS_ORIGIN: value })).toThrow(ConfigValidationError);
  });

  it.each(["", " ", "\t"])("rejects NODE_ENV explicitly set to %j (api)", (value) => {
    expect(() => loadApiConfig({ NODE_ENV: value })).toThrow(ConfigValidationError);
  });

  it.each(["", " "])("rejects NODE_ENV explicitly set to %j (worker)", (value) => {
    expect(() => loadWorkerConfig({ NODE_ENV: value })).toThrow(ConfigValidationError);
  });

  it.each(["", " ", "\t"])("rejects WEB_PORT explicitly set to %j", (value) => {
    expect(() => loadWebRuntimeConfig({ WEB_PORT: value })).toThrow(ConfigValidationError);
  });

  it.each(["", " "])("rejects NEXT_PUBLIC_API_URL explicitly set to %j", (value) => {
    expect(() => parsePublicWebConfig({ NEXT_PUBLIC_API_URL: value })).toThrow();
  });

  it("still applies the default when a variable is entirely absent (not merely falsy)", () => {
    expect(loadApiConfig({}).API_PORT).toBe(3001);
    expect(loadWebRuntimeConfig({}).WEB_PORT).toBe(3000);
  });
});
