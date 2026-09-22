import type { MemoryItem, MemoryType, Entity, Relation, RelationType } from '@dai-brain/shared';

export interface ItemRow {
  id: string;
  tenant: string;
  user_id: string;
  project: string;
  type: string;
  content: string;
  content_hash: string;
  source: string;
  confidence: number;
  created_at: Date;
  updated_at: Date;
  superseded_by: string | null;
  conversation_id: string | null;
  embedding_model: string | null;
}

export function toItem(row: ItemRow): MemoryItem {
  return {
    id: row.id,
    scope: { tenant: row.tenant, user: row.user_id, project: row.project },
    type: row.type as MemoryType,
    content: row.content,
    source: row.source,
    confidence: row.confidence,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    supersededBy: row.superseded_by,
    conversationId: row.conversation_id,
  };
}

export interface EntityRow {
  id: string;
  tenant: string;
  user_id: string;
  project: string;
  name: string;
  name_norm: string;
  kind: string;
  created_at: Date;
}

export function toEntity(row: EntityRow): Entity {
  return {
    id: row.id,
    scope: { tenant: row.tenant, user: row.user_id, project: row.project },
    name: row.name,
    kind: row.kind,
    createdAt: row.created_at.toISOString(),
  };
}

export interface RelationRow {
  id: string;
  from_entity: string;
  to_entity: string;
  type: string;
  weight: number;
  evidence_item: string | null;
}

export function toRelation(row: RelationRow): Relation {
  return {
    id: row.id,
    fromEntity: row.from_entity,
    toEntity: row.to_entity,
    type: row.type as RelationType,
    weight: row.weight,
    evidenceItem: row.evidence_item,
  };
}

/** Columns every item read selects. Kept in one place so `toItem` cannot drift. */
export const ITEM_COLUMNS = `id, tenant, user_id, project, type, content, content_hash,
  source, confidence, created_at, updated_at, superseded_by, conversation_id, embedding_model`;
