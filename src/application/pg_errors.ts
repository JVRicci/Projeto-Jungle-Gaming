export function isUniqueConstraintError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const e = err as { code?: string; name?: string; cause?: { code?: string } };
    return (
        e.name === "UniqueConstraintViolationException" ||
        e.code === "23505" ||
        e.cause?.code === "23505"
    );
}