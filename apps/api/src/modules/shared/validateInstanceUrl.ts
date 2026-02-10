export const validateInstanceUrl = (
  url: string
): { ok: true; origin: string } | { ok: false; error: string } => {
  let instanceUrl: URL;

  try {
    instanceUrl = new URL(url);
  } catch {
    return { ok: false, error: "Invalid instanceUrl" };
  }

  if (instanceUrl.protocol !== "https:" && instanceUrl.protocol !== "http:") {
    return { ok: false, error: "instanceUrl must use https or http" };
  }

  return { ok: true, origin: instanceUrl.origin };
};
