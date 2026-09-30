import { parsePublicWebConfig } from "@relis/config/public";

// The literal `process.env.NEXT_PUBLIC_API_URL` reference must stay exactly
// like this (not passed through a shared-package function that reads
// process.env itself) so Next.js's build-time static replacement can still
// inline it into the client bundle.
export const publicConfig = parsePublicWebConfig({
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
});
