export const validateInstanceUrl = (
  url: string
): { ok: true; origin: string } | { ok: false; error: string } => {
  let instanceUrl: URL;

  try {
    instanceUrl = new URL(url);
  } catch {
    return { ok: false, error: "Invalid instanceUrl" };
  }

  if (instanceUrl.protocol !== "https:") {
    return { ok: false, error: "instanceUrl must use https" };
  }

  const hostname = instanceUrl.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "0.0.0.0"
  ) {
    return { ok: false, error: "instanceUrl must not target localhost" };
  }

  return { ok: true, origin: instanceUrl.origin };
};
