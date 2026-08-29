/**
 * Notification obligation contract tests (Phase 0M.N1).
 *
 * Offline and pure. No database, no clock, no network. Every value is synthetic.
 */

import { describe, expect, it } from "vitest";
import {
  CreateNotificationObligationInput,
  IMPLEMENTED_NOTIFICATION_CATEGORIES,
  INITIAL_NOTIFICATION_OBLIGATION_STATUS,
  NEVER_ON_NOTIFICATION_OBLIGATION,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_OBLIGATION_STATUSES,
  NOTIFICATION_OBLIGATION_TRANSITIONS,
  NOTIFICATION_SUBJECT_KINDS,
  NotificationCategory,
  NotificationObligationRecord,
  NotificationSubjectKind,
  RecordOfferChangeObligationsInput,
  isOpenNotificationObligation,
  isValidNotificationObligationTransition,
  notificationObligationKey,
} from "../src/contracts/marketplace/notification-obligation";
import { OFFER_BUSINESS_CHANGE_CATEGORIES } from "../src/contracts/marketplace/offer-source";

const OBLIGATION = "mon:nobl:N1B00000000000000000000000";
const PROMOTER = "mon:mpart:N1PR0M00000000000000000000";
const OTHER_PROMOTER = "mon:mpart:N1PR0M20000000000000000000";
const OFFER_SREC = "mon:srec:N1SREC00000000000000000000";
const NOW = "2027-11-01T09:00:00.000Z";

const offerSubject = (versionRef: string | null = "2") => ({
  kind: "OFFER" as const,
  ref: OFFER_SREC,
  versionRef,
});

const key = (overrides: Record<string, unknown> = {}) =>
  notificationObligationKey({
    recipientParticipantId: PROMOTER,
    category: "OFFER_CHANGE",
    subject: offerSubject(),
    contextCode: "WHOLESALE_PRICE_CHANGED",
    ...overrides,
  } as Parameters<typeof notificationObligationKey>[0]);

const record = (overrides: Record<string, unknown> = {}) =>
  NotificationObligationRecord.parse({
    obligationId: OBLIGATION,
    recipientParticipantId: PROMOTER,
    category: "OFFER_CHANGE",
    subject: offerSubject(),
    contextCode: "WHOLESALE_PRICE_CHANGED",
    status: "UNREAD",
    createdAt: NOW,
    acknowledgedAt: null,
    resolvedAt: null,
    archivedAt: null,
    updatedAt: NOW,
    ...overrides,
  });

// — 1 —

describe("0M.N1 · an obligation is a record, never a message", () => {
  it("every NEVER_ON_NOTIFICATION_OBLIGATION key is refused by the create input", () => {
    for (const forbidden of NEVER_ON_NOTIFICATION_OBLIGATION) {
      expect(
        CreateNotificationObligationInput.safeParse({
          recipientParticipantId: PROMOTER,
          category: "OFFER_CHANGE",
          subject: offerSubject(),
          contextCode: "WHOLESALE_PRICE_CHANGED",
          createdAt: NOW,
          [forbidden]: "synthetic",
        }).success,
        `${forbidden} must be refused`,
      ).toBe(false);
    }
  });

  it("names the delivery concerns 0M.N2 owns", () => {
    for (const deferred of [
      "channel",
      "emailAddress",
      "subjectLine",
      "body",
      "template",
      "deliveryAttempts",
      "providerMessageId",
      "sentAt",
    ]) {
      expect(NEVER_ON_NOTIFICATION_OBLIGATION).toContain(deferred);
    }
  });

  it("the record carries no delivery or recipient-contact field", () => {
    const keys = Object.keys(record());
    for (const forbidden of NEVER_ON_NOTIFICATION_OBLIGATION) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("refuses a payload bag", () => {
    expect(
      CreateNotificationObligationInput.safeParse({
        recipientParticipantId: PROMOTER,
        category: "OFFER_CHANGE",
        subject: offerSubject(),
        contextCode: "WHOLESALE_PRICE_CHANGED",
        createdAt: NOW,
        payload: { heading: "Your Offer changed" },
      }).success,
    ).toBe(false);
  });
});

// — 2 —

describe("0M.N1 · recipients are participants, never addresses", () => {
  it("requires a mon:mpart: recipient", () => {
    expect(record().recipientParticipantId).toBe(PROMOTER);
    for (const bad of ["promoter@example.invalid", "Promoter Name", "mon:acct:X"]) {
      expect(() => record({ recipientParticipantId: bad })).toThrow();
    }
  });
});

// — 3 —

describe("0M.N1 · lifecycle", () => {
  it("uses exactly the four states the roadmap names", () => {
    expect([...NOTIFICATION_OBLIGATION_STATUSES]).toEqual([
      "UNREAD",
      "ACKNOWLEDGED",
      "RESOLVED",
      "ARCHIVED",
    ]);
  });

  it("is created UNREAD, and the input cannot assert otherwise", () => {
    expect(INITIAL_NOTIFICATION_OBLIGATION_STATUS).toBe("UNREAD");
    expect(
      CreateNotificationObligationInput.safeParse({
        recipientParticipantId: PROMOTER,
        category: "OFFER_CHANGE",
        subject: offerSubject(),
        contextCode: "WHOLESALE_PRICE_CHANGED",
        createdAt: NOW,
        status: "RESOLVED",
      }).success,
    ).toBe(false);
  });

  it("moves forward only, and permits skipping", () => {
    expect(isValidNotificationObligationTransition("UNREAD", "ACKNOWLEDGED")).toBe(true);
    expect(isValidNotificationObligationTransition("UNREAD", "RESOLVED")).toBe(true);
    expect(isValidNotificationObligationTransition("UNREAD", "ARCHIVED")).toBe(true);
    expect(isValidNotificationObligationTransition("ACKNOWLEDGED", "RESOLVED")).toBe(true);
    expect(isValidNotificationObligationTransition("RESOLVED", "ARCHIVED")).toBe(true);
  });

  it("never goes back, and ARCHIVED is terminal", () => {
    expect(isValidNotificationObligationTransition("ACKNOWLEDGED", "UNREAD")).toBe(false);
    expect(isValidNotificationObligationTransition("RESOLVED", "ACKNOWLEDGED")).toBe(false);
    expect(isValidNotificationObligationTransition("ARCHIVED", "RESOLVED")).toBe(false);
    expect(NOTIFICATION_OBLIGATION_TRANSITIONS.ARCHIVED).toEqual([]);
  });

  it("the table is exhaustive over the vocabulary", () => {
    expect(Object.keys(NOTIFICATION_OBLIGATION_TRANSITIONS).sort()).toEqual(
      [...NOTIFICATION_OBLIGATION_STATUSES].sort(),
    );
  });

  it("names the working set an admin panel shows", () => {
    expect(isOpenNotificationObligation("UNREAD")).toBe(true);
    expect(isOpenNotificationObligation("ACKNOWLEDGED")).toBe(true);
    expect(isOpenNotificationObligation("RESOLVED")).toBe(false);
    expect(isOpenNotificationObligation("ARCHIVED")).toBe(false);
  });

  it("has no DELETED state — archiving is not deletion", () => {
    expect(NOTIFICATION_OBLIGATION_STATUSES as readonly string[]).not.toContain("DELETED");
  });
});

// — 4 —

describe("0M.N1 · deduplication identity", () => {
  it("is stable for the same tuple", () => {
    expect(key()).toBe(key());
  });

  /** The governed rule: promoter × exact Offer version × change category. */
  it("differs on the promoter", () => {
    expect(key({ recipientParticipantId: OTHER_PROMOTER })).not.toBe(key());
  });

  it("differs on the exact Offer source version", () => {
    expect(key({ subject: offerSubject("3") })).not.toBe(key());
  });

  it("differs on the change category", () => {
    expect(key({ contextCode: "COMMISSION_TERMS_CHANGED" })).not.toBe(key());
  });

  it("differs on the category and the subject kind", () => {
    expect(key({ category: "ORDER_CONFIRMATION" })).not.toBe(key());
    expect(key({ subject: { kind: "ORDER", ref: OFFER_SREC, versionRef: "2" } })).not.toBe(key());
  });

  /**
   * The reason the key is derived rather than a composite index: MySQL treats
   * each NULL in a unique index as distinct, so a composite over two nullable
   * components would permit exactly the duplicates this prevents.
   */
  it("distinguishes an absent component from a present one", () => {
    const absentVersion = key({ subject: offerSubject(null) });
    const absentContext = key({ contextCode: null });
    expect(absentVersion).not.toBe(key());
    expect(absentContext).not.toBe(key());
    expect(absentVersion).not.toBe(absentContext);
  });

  it("refuses a component containing the separator rather than escaping it", () => {
    expect(() => key({ subject: { kind: "ORDER", ref: "a|b", versionRef: null } })).toThrow(
      /separator/,
    );
  });
});

// — 5 —

describe("0M.N1 · Offer-change integration reuses the committed classifier", () => {
  it("the context vocabulary is the Offer business-change vocabulary", () => {
    for (const category of OFFER_BUSINESS_CHANGE_CATEGORIES) {
      expect(() => record({ contextCode: category })).not.toThrow();
    }
  });

  it("refuses a context code outside that vocabulary", () => {
    for (const bad of ["PRICE_WENT_UP", "the wholesale price changed", "*"]) {
      expect(() => record({ contextCode: bad })).toThrow();
    }
  });

  it("requires at least one distinct change category", () => {
    const base = {
      internalOfferId: "mon:offer:N10FFER0000000000000000000",
      offerSourceRecordId: OFFER_SREC,
      effectiveOfferSourceRecordVersion: "2",
      priorOfferSourceRecordVersion: "1",
      createdAt: NOW,
    };
    expect(
      RecordOfferChangeObligationsInput.safeParse({ ...base, changeCategories: [] }).success,
    ).toBe(false);
    expect(
      RecordOfferChangeObligationsInput.safeParse({
        ...base,
        changeCategories: ["WHOLESALE_PRICE_CHANGED", "WHOLESALE_PRICE_CHANGED"],
      }).success,
    ).toBe(false);
    expect(
      RecordOfferChangeObligationsInput.safeParse({
        ...base,
        changeCategories: ["WHOLESALE_PRICE_CHANGED", "COMMISSION_TERMS_CHANGED"],
      }).success,
    ).toBe(true);
  });

  /** Recipients are derived by the service; a caller cannot name its own. */
  it("accepts no recipient list", () => {
    expect(
      RecordOfferChangeObligationsInput.safeParse({
        internalOfferId: "mon:offer:N10FFER0000000000000000000",
        offerSourceRecordId: OFFER_SREC,
        effectiveOfferSourceRecordVersion: "2",
        priorOfferSourceRecordVersion: "1",
        changeCategories: ["WHOLESALE_PRICE_CHANGED"],
        createdAt: NOW,
        recipientParticipantIds: [PROMOTER],
      }).success,
    ).toBe(false);
  });
});

// — 6 —

describe("0M.N1 · the vocabulary stays closed and 0M.9-ready", () => {
  it("names future categories without implementing them", () => {
    for (const future of [
      "ORDER_CONFIRMATION",
      /* Added in Phase 1.1 for the expiry notice. It creates no OBLIGATION —
         only a delivery — so the implemented-producer list below is unchanged. */
      "ORDER_CANCELLED",
      "SALE_RECORDED",
      "PAYMENT_FAILED",
      "PAYOUT_STATE_CHANGED",
      "REFUND_OR_CHARGEBACK",
      "REVIEW_ELIGIBILITY",
      "OPERATIONAL_ACTION_REQUIRED",
    ]) {
      expect(NOTIFICATION_CATEGORIES).toContain(future);
    }
    /* Corrected in Phase 1.14. This asserted `["OFFER_CHANGE"]` long after
       producers had landed for four more categories, so a constant whose entire
       job is to say what is real had become the least reliable statement in the
       module — and a test was pinning it there. What the assertion is FOR is
       that the list names only categories something actually produces, so that
       is what it now checks. */
    expect([...IMPLEMENTED_NOTIFICATION_CATEGORIES]).toEqual([
      "OFFER_CHANGE",
      "SALE_RECORDED",
      "PAYMENT_FAILED",
      "REFUND_OR_CHARGEBACK",
      "OPERATIONAL_ACTION_REQUIRED",
      "PARTICIPANT_STANDING_CHANGED",
    ]);
    /* Still a strict subset: naming a category here that nothing raises would be
       the same overclaim in the other direction. */
    for (const implemented of IMPLEMENTED_NOTIFICATION_CATEGORIES) {
      expect(NOTIFICATION_CATEGORIES, implemented).toContain(implemented);
    }
    expect(IMPLEMENTED_NOTIFICATION_CATEGORIES.length).toBeLessThan(
      NOTIFICATION_CATEGORIES.length,
    );
  });

  it("refuses an unknown category or subject kind", () => {
    for (const unknown of ["ANYTHING", "offer_change", "*", ""]) {
      expect(NotificationCategory.safeParse(unknown).success, unknown).toBe(false);
      expect(NotificationSubjectKind.safeParse(unknown).success, unknown).toBe(false);
    }
  });

  /** A future category needs no new column — only a new vocabulary member. */
  it("an order-shaped obligation validates against the same record", () => {
    const order = record({
      category: "ORDER_CONFIRMATION",
      subject: { kind: "ORDER", ref: "mon:order:SYNTHETIC", versionRef: null },
      contextCode: null,
    });
    expect(order.category).toBe("ORDER_CONFIRMATION");
    expect(order.subject.versionRef).toBeNull();
    expect(order.contextCode).toBeNull();
  });

  it("subject kinds cover the domains 0M.9 will need", () => {
    expect([...NOTIFICATION_SUBJECT_KINDS]).toEqual([
      "OFFER",
      "ORDER",
      "PAYMENT",
      "PAYOUT",
      "REVIEW",
      /* Phase 1.14. The subject is the DECISION, never the participant: two
         decisions about one participant must produce two obligations, and a
         participant-keyed subject would collapse them into one and silently lose
         the second. */
      "PARTICIPANT_DECISION",
    ]);
  });
});
