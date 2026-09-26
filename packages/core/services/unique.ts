import { Prisma } from '@sales-tracker/db';
import { DomainError } from '../errors.ts';

/**
 * Maps a unique-index violation (P2002) to a field error. Services check first for a
 * friendly message; this covers the race where two requests insert the same name at once
 * and the partial unique index is the final guard.
 */
export async function guardUnique<T>(
  field: string,
  message: string,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new DomainError(message, { field });
    }
    throw error;
  }
}

/** Case-insensitive exact match for names (mirrors the lower(name) partial indexes). */
export function nameEquals(name: string) {
  return { equals: name, mode: 'insensitive' as const };
}
