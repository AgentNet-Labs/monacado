/**
 * Creator-identity ruling (ADR §10.3 amendment), against a real database.
 *
 * Proves the persistence and publication halves of the ruling:
 *   - a participant-authored private draft persists with NULL `factCreatorRef`
 *     and NULL `authorityCreatorId` — no synthetic identity is written — and
 *     round-trips to a record that simply has none;
 *   - its creator authority is the participant, exactly as Listing/Offer
 *     authority already reads it;
 *   - publication preparation refuses it with PRODUCT_CREATOR_IDENTITY_UNBOUND
 *     and leaves no publication or outbox row behind;
 *   - once a real creator relationship is present, the same Product publishes;
 *   - an existing creator-backed record persists and reads back unchanged.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MONACADO_PUBLISHER_ID, type ProductSourceRecord } from "../src/contracts/index";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import { createDraftParticipant } from "../src/server/marketplace/participant-service";
import { participantHoldsProductAuthority } from "../src/server/marketplace/product-authority-service";
import { ProductRepository } from "../src/server/product/product-repository";
import {
  MONACADO_REGISTRAR_ID,
  ProductNodeRepository,
} from "../src/server/product/product-node-repository";
import { ProductPublicationService } from "../src/server/product/product-publication-service";
import { ProductCreatorIdentityUnboundError } from "../src/server/product/publication-errors";
import { ProductCreatorIdentityUnboundError as ContractCreatorIdentityUnboundError } from "../src/contracts/product/product-source-record";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);
const repo = RUN ? new ProductRepository(db) : (undefined as unknown as ProductRepository);
const nodes = RUN ? new ProductNodeRepository(db) : (undefined as unknown as ProductNodeRepository);
const pubs = RUN
  ? new ProductPublicationService(db)
  : (undefined as unknown as ProductPublicationService);

const EMAIL_PREFIX = "creatorident";
const pad26 = (s: string): string =>
  (s.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);
let n = 0;

async function cleanup(): Promise<void> {
  const accountIds = (
    await db.account.findMany({ where: { email: { startsWith: EMAIL_PREFIX } }, select: { id: true } })
  ).map((a) => a.id);
  const participantIds = (
    await db.marketplaceParticipant.findMany({
      where: { accountId: { in: accountIds } },
      select: { id: true },
    })
  ).map((p) => p.id);

  /* This suite's Products: those its participants author, and its legacy
     creator-backed fixture (`pad26` turns the "CI" prefix into "C0"). */
  const products = await db.productSourceRecordVersionRow.findMany({
    where: {
      OR: [
        { authorityCreatorParticipantId: { in: participantIds } },
        { sourceRecordId: { startsWith: "mon:srec:C0" } },
      ],
    },
    select: { internalProductId: true },
  });
  const productIds = [...new Set(products.map((p) => p.internalProductId))];
  const publicationIds = (
    await db.productPublication.findMany({
      where: { internalProductId: { in: productIds } },
      select: { publicationId: true },
    })
  ).map((p) => p.publicationId);
  await db.publicationOutbox.deleteMany({ where: { publicationId: { in: publicationIds } } });
  await db.productPublication.deleteMany({ where: { publicationId: { in: publicationIds } } });
  await db.productNode.deleteMany({ where: { internalProductId: { in: productIds } } });
  await db.productSourceRecordVersionRow.deleteMany({ where: { internalProductId: { in: productIds } } });
  await db.product.deleteMany({ where: { internalProductId: { in: productIds } } });

  await db.marketplaceRoleAssignment.deleteMany({ where: { participantId: { in: participantIds } } });
  await db.marketplaceParticipant.deleteMany({ where: { id: { in: participantIds } } });
  await db.account.deleteMany({ where: { id: { in: accountIds } } });
}

async function seller(): Promise<string> {
  n += 1;
  const account = await createAccount(
    {
      name: "Creator",
      email: `${EMAIL_PREFIX}${n}@example.com`,
      password: "correct horse battery staple",
      createdAt: "2028-07-01T09:00:00.000Z",
    },
    { db },
  );
  const participant = await createDraftParticipant(
    { accountId: account.accountId, initialRoles: ["SELLER"], now: "2028-07-01T09:00:00.000Z" },
    { db },
  );
  return participant.participant.participantId;
}

/** A participant-authored private draft: participant authority, no public creator identity. */
function unboundDraft(participantId: string): ProductSourceRecord {
  n += 1;
  return {
    sourceRecordId: `mon:srec:${pad26(`CI${n}SREC`)}`,
    sourceRecordVersion: "1",
    internalProductId: `mon:product:${pad26(`CI${n}PRD`)}`,
    sourceSystem: "monacado",
    sourceRecordType: "Product",
    sourceClass: "governed-database-record",
    authority: {
      authorityScope: "product-facts",
      authorizationState: "authorized",
      creatorParticipantId: participantId,
    },
    facts: {
      name: "Unbound draft",
      productVersion: 1,
      promotable: false,
      generalAvailabilityState: "pre-release",
      deliveryMode: "DIGITAL",
      relationships: {},
    },
    capsuleSemver: "1.0.0",
    mappingVersion: "0e.2.0.0",
    recordStatus: "draft",
    createdAt: "2028-07-01T09:00:00.000Z",
    updatedAt: "2028-07-01T09:00:00.000Z",
    acquiredAt: "2028-07-01T09:00:00.000Z",
    capsuleGeneratedAt: "2028-07-01T09:00:00.000Z",
  };
}

const rawRow = (sourceRecordId: string, sourceRecordVersion: string) =>
  db.productSourceRecordVersionRow.findUnique({
    where: { sourceRecordId_sourceRecordVersion: { sourceRecordId, sourceRecordVersion } },
  });

async function activeNode(internalProductId: string): Promise<string> {
  const node = await nodes.issueProductNode({
    nodeId: `an:node:${pad26(`CI${n}NODE`)}`,
    internalProductId,
    nodeKind: "product",
    nodePolicyRef: "an:policy:node:synthetic-ci",
    nodePolicyVersion: "1.0.0",
    registrarId: MONACADO_REGISTRAR_ID,
    issuedAt: "2028-07-02T00:00:00.000Z",
  });
  return node.nodeId;
}

let pubSeq = 0;
function prepInput(record: ProductSourceRecord, nodeId: string, sourceRecordVersion = "1") {
  pubSeq += 1;
  return {
    publicationId: `mon:pub:${pad26(`CIPUB${pubSeq}`)}`,
    internalProductId: record.internalProductId,
    sourceRecordId: record.sourceRecordId,
    sourceRecordVersion,
    nodeId,
    capsuleId: `an:capsule:${pad26(`CICAP${pubSeq}`)}`,
    capsuleSemver: record.capsuleSemver,
    publishedBy: MONACADO_PUBLISHER_ID,
    publishedAt: "2028-07-03T00:00:00.000Z",
    nodePolicy: { ref: "an:policy:node:synthetic-ci", version: "1.0.0" },
    capsulePolicy: { ref: "an:policy:capsule:synthetic-ci", version: "1.0.0" },
    availableAt: "2028-07-03T00:00:00.000Z",
  };
}

describe.skipIf(!RUN)("creator-identity ruling (integration)", () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  it("persists a participant-authored draft with NULL creator columns and reads it back unbound", async () => {
    const participantId = await seller();
    const draft = unboundDraft(participantId);

    await repo.createInitialProductSourceRecord({ record: draft });

    const row = await rawRow(draft.sourceRecordId, "1");
    expect(row!.factCreatorRef).toBeNull();
    expect(row!.authorityCreatorId).toBeNull();
    expect(row!.authorityCreatorParticipantId).toBe(participantId);

    const readBack = await repo.getCurrentProductSourceRecord(draft.internalProductId);
    expect(readBack).toEqual(draft);
    expect(readBack.facts.relationships.creator).toBeUndefined();
    expect(readBack.authority.creatorId).toBeUndefined();

    /* Creator authority is the participant — the same read Listing and Offer use. */
    expect(await participantHoldsProductAuthority(db, draft.internalProductId, participantId)).toBe(true);
    expect(await participantHoldsProductAuthority(db, draft.internalProductId, await seller())).toBe(false);

    /* And it cannot become a candidate. */
    await expect(
      repo.generateCandidateFromPersistedProductVersion(draft.sourceRecordId, "1"),
    ).rejects.toBeInstanceOf(ContractCreatorIdentityUnboundError);
  });

  it("refuses to prepare publication for an unbound draft, writing nothing", async () => {
    const participantId = await seller();
    const draft = unboundDraft(participantId);
    await repo.createInitialProductSourceRecord({ record: draft });
    const nodeId = await activeNode(draft.internalProductId);

    const refusal = pubs.prepareProductPublication(prepInput(draft, nodeId));
    await expect(refusal).rejects.toBeInstanceOf(ProductCreatorIdentityUnboundError);
    await expect(refusal).rejects.toMatchObject({ code: "PRODUCT_CREATOR_IDENTITY_UNBOUND" });

    expect(await db.productPublication.count({ where: { internalProductId: draft.internalProductId } })).toBe(0);
    /* No publication row means no outbox row can exist either: the outbox is keyed
       by publicationId. Checked directly against this attempt's id too. */
    expect(await db.publicationOutbox.count({ where: { publicationId: `mon:pub:${pad26(`CIPUB${pubSeq}`)}` } })).toBe(0);
  });

  it("publishes once a real creator relationship is bound in a later version", async () => {
    const participantId = await seller();
    const draft = unboundDraft(participantId);
    await repo.createInitialProductSourceRecord({ record: draft });
    const creatorNode = `an:node:${pad26(`CI${n}CRNODE`)}`;

    await repo.createProductSourceRecordRevision({
      internalProductId: draft.internalProductId,
      expectedCurrentSourceRecordVersion: "1",
      sourceRecordVersion: "2",
      updatedAt: "2028-07-02T09:00:00.000Z",
      capsuleGeneratedAt: "2028-07-02T09:00:00.000Z",
      facts: { ...draft.facts, relationships: { creator: creatorNode } },
    });
    expect((await rawRow(draft.sourceRecordId, "2"))!.factCreatorRef).toBe(creatorNode);
    /* Version 1 is untouched and still unbound. */
    expect((await rawRow(draft.sourceRecordId, "1"))!.factCreatorRef).toBeNull();

    const nodeId = await activeNode(draft.internalProductId);
    const prepared = await pubs.prepareProductPublication(prepInput(draft, nodeId, "2"));
    expect(prepared.publication.publicationStatus).toBe("QUEUED");
    expect(prepared.outbox.payload!.data.relationships.creator).toBe(creatorNode);
  });

  it("keeps an existing creator-backed record exactly as it was", async () => {
    n += 1;
    const legacy: ProductSourceRecord = {
      ...unboundDraft(await seller()),
      authority: {
        creatorId: `mon:creator:${pad26(`CI${n}CRTR`)}`,
        authorityScope: "product-facts",
        authorizationState: "authorized",
      },
      facts: {
        ...unboundDraft("mon:mpart:01ARZ3NDEKTSV4RRFFQ69G5FAV").facts,
        relationships: { creator: `an:node:${pad26(`CI${n}LGCY`)}` },
      },
    };
    await repo.createInitialProductSourceRecord({ record: legacy });

    const row = await rawRow(legacy.sourceRecordId, "1");
    expect(row!.authorityCreatorId).toBe(legacy.authority.creatorId);
    expect(row!.factCreatorRef).toBe(legacy.facts.relationships.creator);
    expect(row!.authorityCreatorParticipantId).toBeNull();
    expect(await repo.getCurrentProductSourceRecord(legacy.internalProductId)).toEqual(legacy);
    await expect(
      repo.generateCandidateFromPersistedProductVersion(legacy.sourceRecordId, "1"),
    ).resolves.toMatchObject({ data: { relationships: { creator: legacy.facts.relationships.creator } } });
  });
});
