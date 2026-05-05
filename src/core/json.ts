export const parseJsonObject = (value: string | null | undefined): Record<string, unknown> => {
  if (!value) return {};
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
};

export const parseJsonArray = (value: string | null | undefined): unknown[] => {
  if (!value) return [];
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed : [];
};

export const stringifyJson = (value: unknown): string => JSON.stringify(value ?? null);

export const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

export const asStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  }
  if (typeof value === "string" && value.length > 0) {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
};
