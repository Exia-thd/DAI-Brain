import type { Entity, Relation, RelationType, Scope, WriteScope } from '@dai-brain/shared';
import { entityId, relationId } from '../util/ids.js';
import { normalize } from '../util/text.js';
import { toEntity, toRelation, type EntityRow, type RelationRow } from './rows.js';
import { scopeKey, scopeWhere } from './scope-sql.js';
import type { Queryable } from './items.js';

const ENTITY_COLUMNS = 'id, tenant, user_id, project, name, name_norm, kind, created_at';
const RELATION_COLUMNS = 'id, from_entity, to_entity, type, weight, evidence_item';

export async function upsertEntity(
  db: Queryable,
  scope: WriteScope,
  name: string,
  kind = 'concept',
): Promise<Entity> {
  const nameNorm = normalize(name);
  if (nameNorm.length === 0) throw new Error('entity name is empty after normalisation');
  const id = entityId(scopeKey(scope), nameNorm);
  const { rows } = await db.query<EntityRow>(
    `INSERT INTO entities (id, tenant, user_id, project, name, name_norm, kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (tenant, user_id, project, name_norm) DO UPDATE
       -- The first spelling wins for display, but a later, more specific kind
       -- upgrades the node: 'concept' is what the linker guesses when it has
       -- nothing better, and anything else is real information.
       SET kind = CASE WHEN entities.kind = 'concept' THEN EXCLUDED.kind ELSE entities.kind END
     RETURNING ${ENTITY_COLUMNS}`,
    [id, scope.tenant, scope.user, scope.project, name, nameNorm, kind],
  );
  return toEntity(rows[0]!);
}

export async function linkItemToEntities(
  db: Queryable,
  itemId: string,
  entityIds: string[],
): Promise<void> {
  if (entityIds.length === 0) return;
  await db.query(
    `INSERT INTO item_entities (item_id, entity_id)
     SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
    [itemId, entityIds],
  );
}

export async function upsertRelation(
  db: Queryable,
  from: string,
  to: string,
  type: RelationType,
  weight = 1.0,
  evidenceItem: string | null = null,
): Promise<Relation> {
  const id = relationId(from, to, type);
  const { rows } = await db.query<RelationRow>(
    `INSERT INTO relations (id, from_entity, to_entity, type, weight, evidence_item)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (from_entity, to_entity, type) DO UPDATE
       -- Seeing an edge again is more evidence for it, capped so a chatty
       -- conversation cannot make one relation outweigh the whole graph.
       SET weight = LEAST(relations.weight + 0.25, 5.0),
           evidence_item = COALESCE(EXCLUDED.evidence_item, relations.evidence_item)
     RETURNING ${RELATION_COLUMNS}`,
    [id, from, to, type, weight, evidenceItem],
  );
  return toRelation(rows[0]!);
}

/**
 * Entities in this scope whose normalised name appears in the query text.
 *
 * Substring containment against the normalised query, done in Postgres so it
 * uses the index rather than pulling every entity into the process. Longest
 * names first: "brain gateway" is a better anchor than "brain", and the caller
 * only takes the top few.
 */
export async function linkEntities(
  db: Queryable,
  scope: Scope,
  query: string,
  limit = 8,
): Promise<Entity[]> {
  const normalized = normalize(query);
  if (normalized.length === 0) return [];
  const params: unknown[] = [normalized];
  const { rows } = await db.query<EntityRow>(
    `SELECT ${ENTITY_COLUMNS} FROM entities
      WHERE ${scopeWhere(scope, params)}
        AND position(name_norm in $1) > 0
      ORDER BY length(name_norm) DESC, name
      LIMIT $${params.push(limit)}`,
    params,
  );
  return rows.map(toEntity);
}

export async function findEntity(db: Queryable, scope: Scope, name: string): Promise<Entity | null> {
  const params: unknown[] = [normalize(name)];
  const { rows } = await db.query<EntityRow>(
    `SELECT ${ENTITY_COLUMNS} FROM entities
      WHERE name_norm = $1 AND ${scopeWhere(scope, params)} LIMIT 1`,
    params,
  );
  return rows[0] ? toEntity(rows[0]) : null;
}

export interface Subgraph {
  entities: Entity[];
  relations: Relation[];
  /** Entity ids at each hop, so a caller can weight by distance. */
  byDepth: Map<string, number>;
  truncated: boolean;
}

export const MAX_DEPTH = 3;
const MAX_NODES = 200;

/**
 * Breadth-first expansion from a set of seeds, undirected.
 *
 * Undirected because a memory graph's edges record association, not flow: if a
 * decision DEPENDS_ON a component, asking about the component should reach the
 * decision. Directed traversal here would make half the graph unreachable from
 * the half of queries that name the other end.
 */
export async function expand(
  db: Queryable,
  scope: Scope,
  seedIds: string[],
  depth: number,
): Promise<Subgraph> {
  const byDepth = new Map<string, number>();
  for (const id of seedIds) byDepth.set(id, 0);
  const relations = new Map<string, Relation>();
  let truncated = false;
  let frontier = [...seedIds];

  const hops = Math.min(Math.max(depth, 0), MAX_DEPTH);
  for (let hop = 1; hop <= hops && frontier.length > 0; hop++) {
    const { rows } = await db.query<RelationRow>(
      `SELECT ${RELATION_COLUMNS} FROM relations
        WHERE from_entity = ANY($1::text[]) OR to_entity = ANY($1::text[])`,
      [frontier],
    );
    const next: string[] = [];
    for (const row of rows) {
      relations.set(row.id, toRelation(row));
      for (const side of [row.from_entity, row.to_entity]) {
        if (byDepth.has(side)) continue;
        if (byDepth.size >= MAX_NODES) { truncated = true; continue; }
        byDepth.set(side, hop);
        next.push(side);
      }
    }
    frontier = next;
  }

  const ids = [...byDepth.keys()];
  const params: unknown[] = [ids];
  // Re-filtering by scope is not redundant. Relation rows carry no scope of
  // their own, so an edge is only as trustworthy as the entities it joins; this
  // is the check that keeps a mis-written edge from walking out of the scope.
  const { rows: entityRows } = ids.length === 0
    ? { rows: [] as EntityRow[] }
    : await db.query<EntityRow>(
        `SELECT ${ENTITY_COLUMNS} FROM entities
          WHERE id = ANY($1::text[]) AND ${scopeWhere(scope, params)}`,
        params,
      );

  const visible = new Set(entityRows.map((r) => r.id));
  for (const id of [...byDepth.keys()]) if (!visible.has(id)) byDepth.delete(id);

  return {
    entities: entityRows.map(toEntity),
    relations: [...relations.values()].filter(
      (r) => visible.has(r.fromEntity) && visible.has(r.toEntity),
    ),
    byDepth,
    truncated,
  };
}

/** Item ids attached to any of these entities, nearest entity first. */
export async function itemsForEntities(
  db: Queryable,
  scope: Scope,
  entityIds: string[],
  limit = 50,
): Promise<{ itemId: string; entityId: string }[]> {
  if (entityIds.length === 0) return [];
  const params: unknown[] = [entityIds];
  const { rows } = await db.query<{ item_id: string; entity_id: string }>(
    `SELECT ie.item_id, ie.entity_id
       FROM item_entities ie
       JOIN memory_items mi ON mi.id = ie.item_id
      WHERE ie.entity_id = ANY($1::text[])
        AND mi.superseded_by IS NULL
        AND ${scopeWhere(scope, params, 'mi')}
      ORDER BY mi.updated_at DESC
      LIMIT $${params.push(limit)}`,
    params,
  );
  return rows.map((r) => ({ itemId: r.item_id, entityId: r.entity_id }));
}

export async function entitiesForItems(
  db: Queryable,
  itemIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (itemIds.length === 0) return out;
  const { rows } = await db.query<{ item_id: string; name: string }>(
    `SELECT ie.item_id, e.name FROM item_entities ie
       JOIN entities e ON e.id = ie.entity_id
      WHERE ie.item_id = ANY($1::text[])`,
    [itemIds],
  );
  for (const row of rows) {
    const list = out.get(row.item_id) ?? [];
    list.push(row.name);
    out.set(row.item_id, list);
  }
  return out;
}
