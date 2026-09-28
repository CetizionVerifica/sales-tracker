import type { Role } from '@sales-tracker/db';

export type Action = 'read' | 'list' | 'create' | 'update' | 'delete';

/** The acting user as can() sees it. */
export interface Actor {
  id: string;
  role: Role;
  active: boolean;
}

/**
 * A resource is either a type (for `create`/`list`, where no row exists yet) or an instance
 * carrying the ownership fields its rule needs. Callers load those fields before checking.
 */
export type ResourceInstance =
  | { type: 'user'; id: string }
  | { type: 'master' }
  | { type: 'client' }
  | { type: 'settings' }
  | { type: 'auditLog'; actorId: string }
  | { type: 'apiToken' }
  | { type: 'enquiry'; ownerId: string; projectManagerIds: readonly string[] }
  | { type: 'quotation'; ownerId: string; projectManagerIds: readonly string[] }
  | { type: 'project'; managerId: string | null; quotationOwnerId: string }
  | { type: 'purchaseOrder'; projectManagerId: string | null; pipelineOwnerId: string }
  | { type: 'invoice'; projectManagerId: string | null; pipelineOwnerId: string }
  /** `canReadLinked`: whether the actor may read the record the follow-up is on (M5). */
  | { type: 'followUp'; userId: string; canReadLinked: boolean }
  /** A document's permissions are its record's (M7 Decision 4). */
  | { type: 'document'; canReadParent: boolean; canUpdateParent: boolean }
  | { type: 'dashboard'; scope: 'company' | 'personal' | 'project' }
  /** Whose My Today list is being read (M11). */
  | { type: 'myToday'; userId: string }
  /** Monthly exchange rates (M12): a master, like sectors and services. */
  | { type: 'exchangeRate' };

export type ResourceType = ResourceInstance['type'];

export type Resource = ResourceType | ResourceInstance;

export type InstanceOf<T extends ResourceType> = Extract<ResourceInstance, { type: T }>;
