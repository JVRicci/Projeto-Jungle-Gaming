export function isUniqueConstraintError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const e = err as { code?: string; name?: string; cause?: { code?: string } };
    return (
        e.name === "UniqueConstraintViolationException" ||
        e.code === "23505" ||
        e.cause?.code === "23505"
    );
}

const LOCK_CONFLICT_CODES = new Set(["40001", "40P01", "55P03"]);

export function isLockConflictError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const e = err as { code?: string; cause?: { code?: string } };
    return (
        LOCK_CONFLICT_CODES.has(e.code ?? "") ||
        LOCK_CONFLICT_CODES.has(e.cause?.code ?? "")
    );
}