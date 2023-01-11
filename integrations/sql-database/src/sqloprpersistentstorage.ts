/**
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  Clock,
  getUpdateTimestamp,
  loglevel,
  Logger,
  PersistentStorage,
  PersistentStorageUpdateType,
  TransactionType,
  Transaction,
  deepClone,
  decodeChain,
  compareReshareChainsForAccept,
  compareReshareChainsForReshare,
  TimelineEntry,
  Interval,
  StatusError,
  OfferVersionPair,
  OfferProducerMetadata,
  JsonValue,
} from 'opr-core';
import {
  DecodedReshareChain,
  Offer,
  OfferHistory,
  ReshareChain,
} from 'opr-models';
import {
  Brackets,
  DataSource,
  DataSourceOptions,
  EntityManager,
  FindOptionsWhere,
} from 'typeorm';
import {KnownOfferingOrg} from './persistentmodel/knownofferingorg';
import {CorpusOffer} from './persistentmodel/corpusoffer';
import {OfferSnapshot} from './persistentmodel/offersnapshot';
import {StoredReshareChain} from './persistentmodel/storedresharechain';
import {StoredTimelineEntry} from './persistentmodel/storedtimelineentry';
import {StoredRejection} from './persistentmodel/storedrejection';
import {StoredAcceptance} from './persistentmodel/storedacceptance';
import {AcceptanceHistoryViewer} from './persistentmodel/acceptancehistoryviewer';
import {ProducerMetadata} from './persistentmodel/producermetadata';
import {StoredKeyValue} from './persistentmodel/storedkeyvalue';

export {DataSourceOptions} from 'typeorm';

type IsolationLevel =
  | 'READ UNCOMMITTED'
  | 'READ COMMITTED'
  | 'REPEATABLE READ'
  | 'SERIALIZABLE';

export interface SqlOprPersistentStorageOptions {
  clock?: Clock;
  dsOptions: DataSourceOptions;
  enableInternalChecks?: boolean;
  logger?: Logger;
  selectPageSize?: number;
}

export class SqlTransaction implements Transaction {
  private commitCallbackFn: () => void | undefined;
  private rejectCallbackFn: () => void | undefined;
  private completionPromise: Promise<void> | undefined;
  private entityManager: EntityManager;
  private db: DataSource;
  private isolationLevel: IsolationLevel;
  private type: TransactionType;

  constructor(db: DataSource, type: TransactionType) {
    this.type = type;
    const isolationLevel =
      type === 'READONLY'
        ? db.driver.options.type === 'sqlite'
          ? 'READ UNCOMMITTED'
          : 'READ COMMITTED'
        : 'SERIALIZABLE';
    this.isolationLevel = isolationLevel;
    this.db = db;
  }

  async startInternal(): Promise<void> {
    // TODO: Add cleanup functions to fail() this transaction after a long
    // timeout or when the process is exiting.
    if (this.type === 'READONLY') {
      this.entityManager = this.db.manager;
      this.completionPromise = new Promise<void>((acceptFn, rejectFn) => {
        this.commitCallbackFn = acceptFn;
        this.rejectCallbackFn = rejectFn;
      });
    } else {
      return new Promise(startAcceptFn => {
        this.completionPromise = this.db.manager.transaction(
          this.isolationLevel,
          async em => {
            this.entityManager = em;
            startAcceptFn();
            return new Promise<void>((acceptFn, rejectFn) => {
              this.commitCallbackFn = acceptFn;
              this.rejectCallbackFn = rejectFn;
            });
          }
        );
      });
    }
  }

  get em(): EntityManager {
    return this.entityManager;
  }

  async commit(): Promise<void> {
    if (this.completionPromise) {
      this.commitCallbackFn();
      await this.completionPromise;
      this.completionPromise = undefined;
    } else {
      throw new Error('Transaction already completed');
    }
  }

  async fail(): Promise<void> {
    if (this.completionPromise) {
      this.rejectCallbackFn();
      try {
        await this.completionPromise;
      } catch (e) {
        // Since we rejected the outer promise, we expect an exception here.
        // We can safely ignore it - the caller will take appropriate action.
      }
      this.completionPromise = undefined;
    } else {
      throw new Error('Transaction already completed');
    }
  }
}

export class SqlOprPersistentStorage implements PersistentStorage {
  readonly type = 'storage';

  private readonly db: DataSource;
  private initialized = false;
  private initializingPromise: Promise<DataSource> | undefined;
  private logger: Logger;
  private selectPageSize: number;

  constructor(options: SqlOprPersistentStorageOptions) {
    const dsOptions = {
      ...options.dsOptions,
      entities: [
        AcceptanceHistoryViewer,
        CorpusOffer,
        KnownOfferingOrg,
        OfferSnapshot,
        ProducerMetadata,
        StoredAcceptance,
        StoredKeyValue,
        StoredRejection,
        StoredReshareChain,
        StoredTimelineEntry,
      ],
    };
    this.db = new DataSource(dsOptions);
    this.logger = options.logger ?? loglevel.getLogger('SqlOprDatabase');
    this.initialized = false;
    this.selectPageSize = options.selectPageSize ?? 100;
  }

  async initialize(): Promise<void> {
    if (!this.initialized) {
      if (this.initializingPromise) {
        await this.initializingPromise;
        return;
      }
      this.initializingPromise = this.db.initialize();
      await this.initializingPromise;
      this.initializingPromise = undefined;
      this.initialized = true;
    }
  }

  /**
   * Synchronizes database tables to match current datamodels. This method can
   * be called to set up new databases. It should NOT be exposed in production.
   */
  async synchronize(dropBeforeSync = false): Promise<void> {
    await this.initialize();
    await this.db.synchronize(dropBeforeSync);
  }

  async shutdown(): Promise<void> {
    await this.db.destroy();
  }

  async createTransaction(
    type: TransactionType = 'READWRITE'
  ): Promise<SqlTransaction> {
    await this.initialize();
    const t = new SqlTransaction(this.db, type);
    await t.startInternal();
    return t;
  }

  /**
   * Stores a key-value pair for the given host. If a value already exists at
   * the given key, it will be replaced and the old value returned.
   */
  async storeValue(
    t: SqlTransaction,
    hostOrgUrl: string,
    key: string,
    value: JsonValue
  ): Promise<JsonValue | undefined> {
    const oldValue = await t.em.findOneBy(StoredKeyValue, {
      hostOrgUrl: hostOrgUrl,
      key: key,
    } as FindOptionsWhere<StoredKeyValue>);
    const kv = new StoredKeyValue();
    kv.key = key;
    kv.hostOrgUrl = hostOrgUrl;
    kv.value = value;
    await t.em.save(kv);
    return oldValue ? oldValue.value : undefined;
  }

  /**
   * Clears all values for the given host where the key starts with the given
   * prefix. It is very important to namespace keys correctly, since this can
   * easily erase many values. Returns the number of values deleted.
   */
  async clearAllValues(
    t: SqlTransaction,
    hostOrgUrl: string,
    keyPrefix: string
  ): Promise<number | undefined> {
    const deleteResult = await t.em
      .createQueryBuilder()
      .delete()
      .from(StoredKeyValue)
      .where('hostOrgUrl = :hostOrgUrl')
      .andWhere('key LIKE :keyPrefix')
      .setParameters({
        hostOrgUrl: hostOrgUrl,
        keyPrefix: `${keyPrefix.replace(/%/g, '[%]')}%`,
      })
      .execute();
    return deleteResult.affected ?? undefined;
  }

  /**
   * Returns all values for the given host where the key starts with the given
   * prefix.
   */
  async *getValues(
    t: SqlTransaction,
    hostOrgUrl: string,
    keyPrefix: string
  ): AsyncIterable<JsonValue> {
    let selectPage;
    let cursorPos = 0;
    do {
      const query = t.em
        .getRepository(StoredKeyValue)
        .createQueryBuilder('keyval')
        .where('keyval.hostOrgUrl = :hostOrgUrl')
        .andWhere('keyval.key LIKE :keyPrefix')
        .orderBy('keyval.key', 'ASC')
        .setParameters({
          hostOrgUrl: hostOrgUrl,
          keyPrefix: `${keyPrefix.replace(/%/g, '[%]')}%`,
        })
        .skip(cursorPos)
        .take(this.selectPageSize);
      selectPage = await query.getMany();
      for (const keyVal of selectPage) {
        yield keyVal.value;
      }
      cursorPos += this.selectPageSize;
    } while (
      selectPage &&
      selectPage.length &&
      selectPage.length >= this.selectPageSize
    );
  }

  async getOfferFromCorpus(
    t: SqlTransaction,
    hostOrgUrl: string,
    corpusOrgUrl: string,
    postingOrgUrl: string,
    offerId: string
  ): Promise<Offer | undefined> {
    const result = await t.em
      .getRepository(CorpusOffer)
      .createQueryBuilder('corpusoffers')
      .leftJoinAndSelect('corpusoffers.snapshot', 'snapshot')
      .where('corpusoffers.offerId = :offerId')
      .andWhere('corpusoffers.postingOrgUrl = :postingOrgUrl')
      .andWhere('corpusoffers.corpusOrgUrl = :corpusOrgUrl')
      .andWhere('corpusoffers.hostOrgUrl = :hostOrgUrl')
      .setParameters({
        offerId: offerId,
        hostOrgUrl: hostOrgUrl,
        corpusOrgUrl: corpusOrgUrl,
        postingOrgUrl: postingOrgUrl,
      })
      .getOne();
    return result ? result.snapshot.offer : undefined;
  }

  async getOffer(
    t: SqlTransaction,
    hostOrgUrl: string,
    offerId: string,
    postingOrgUrl: string,
    updateTimestampUTC?: number
  ): Promise<Offer | undefined> {
    let query = t.em
      .getRepository(OfferSnapshot)
      .createQueryBuilder('offers')
      .where('offers.offerId = :offerId')
      .andWhere('offers.postingOrgUrl = :postingOrgUrl');
    if (updateTimestampUTC !== undefined) {
      query = query.andWhere('offers.lastUpdateUTC = :updateTimestampUTC');
    }
    query = query.orderBy('offers.lastUpdateUTC', 'DESC');
    const result = await query
      .limit(1)
      .setParameters({
        offerId: offerId,
        hostOrgUrl: hostOrgUrl,
        postingOrgUrl: postingOrgUrl,
        updateTimestampUTC: updateTimestampUTC,
      })
      .getOne();
    return result ? result.offer : undefined;
  }

  async getOfferSources(
    t: SqlTransaction,
    hostOrgUrl: string,
    offerId: string,
    postingOrgUrl: string,
    updateTimestampUTC?: number
  ): Promise<Array<string>> {
    let query = t.em
      .getRepository(CorpusOffer)
      .createQueryBuilder('corpusoffers')
      .select('corpusoffers.corpusOrgUrl', 'corpusOrgUrl')
      .distinct()
      .where('corpusoffers.offerId = :offerId')
      .andWhere('corpusoffers.postingOrgUrl = :postingOrgUrl')
      .andWhere('corpusoffers.hostOrgUrl = :hostOrgUrl');
    if (updateTimestampUTC !== undefined) {
      query = query.andWhere(
        'corpusoffers.lastUpdateUTC = :updateTimestampUTC'
      );
    }
    query = query.orderBy('corpusoffers.corpusOrgUrl', 'ASC');
    const results = await query
      .setParameters({
        offerId: offerId,
        hostOrgUrl: hostOrgUrl,
        updateTimestampUTC: updateTimestampUTC,
        postingOrgUrl: postingOrgUrl,
      })
      .getRawMany();
    return results.map(x => x.corpusOrgUrl);
  }

  async insertOrUpdateOfferInCorpus(
    t: SqlTransaction,
    hostOrgUrl: string,
    corpusOrgUrl: string,
    offer: Offer
  ): Promise<PersistentStorageUpdateType> {
    // TODO: Ignore accepted offers?
    // TODO: Write down the offering org as a KnownOfferingOrg
    offer = deepClone(offer);
    const reshareChain = offer.reshareChain;
    delete offer.reshareChain;

    const offerTimestamp = getUpdateTimestamp(offer);
    // Create a new snapshot object for the incoming offer.
    const snapshot = new OfferSnapshot();
    snapshot.lastUpdateUTC = offerTimestamp;
    snapshot.offerId = offer.id;
    snapshot.postingOrgUrl = offer.offeredBy!;
    snapshot.offer = offer;
    snapshot.expirationUTC = offer.offerExpirationUTC;

    // Check to see if this is a brand-new snapshot
    const bestSnapshotUpdateTime = await this.getNewestSnapshotTimestamp(
      t,
      hostOrgUrl,
      offer.id,
      offer.offeredBy!
    );

    // Check to see if this particular snapshot has been seen before.
    const isUnknownSnapshot =
      (await t.em
        .getRepository(OfferSnapshot)
        .createQueryBuilder('snapshots')
        .select('snapshots.offerId', 'offerId')
        .where('snapshots.offerId = :offerId')
        .andWhere('snapshots.postingOrgUrl = :postingOrgUrl')
        .andWhere('snapshots.lastUpdateUTC = :lastUpdateUTC')
        .setParameters({
          offerId: offer.id,
          postingOrgUrl: offer.offeredBy!,
          lastUpdateUTC: offerTimestamp,
        })
        .getCount()) === 0;
    if (isUnknownSnapshot) {
      // If we haven't seen it before, write the snapshot down.
      await t.em.save(snapshot);
    }
    // Find the version of this offer in this corpus
    const currentCorpusInfo = await t.em
      .getRepository(CorpusOffer)
      .createQueryBuilder('corpusoffers')
      .select('corpusoffers.lastUpdateUTC', 'lastUpdateUTC')
      .where('corpusoffers.offerId = :offerId')
      .andWhere('corpusoffers.postingOrgUrl = :postingOrgUrl')
      .andWhere('corpusoffers.corpusOrgUrl = :corpusOrgUrl')
      .andWhere('corpusoffers.hostOrgUrl = :hostOrgUrl')
      .setParameters({
        offerId: offer.id,
        hostOrgUrl: hostOrgUrl,
        corpusOrgUrl: corpusOrgUrl,
        postingOrgUrl: offer.offeredBy!,
      })
      .getRawOne();
    if (
      !currentCorpusInfo ||
      currentCorpusInfo.lastUpdateUTC < offerTimestamp
    ) {
      // The incoming offer is newer than the one we have stored. Replace the
      // version in this corpus.
      const corpusOffer = new CorpusOffer();
      corpusOffer.corpusOrgUrl = corpusOrgUrl;
      corpusOffer.hostOrgUrl = hostOrgUrl;
      corpusOffer.offerId = offer.id;
      corpusOffer.postingOrgUrl = offer.offeredBy!;
      corpusOffer.lastUpdateUTC = offerTimestamp;
      corpusOffer.snapshot = snapshot;
      await t.em.save(corpusOffer);

      const lastKnownRecord =
        (await t.em
          .getRepository(KnownOfferingOrg)
          .createQueryBuilder('knownorgs')
          .andWhere('knownorgs.hostOrgUrl = :hostOrgUrl')
          .andWhere('knownorgs.orgUrl = :knownOrgUrl')
          .setParameters({
            hostOrgUrl: hostOrgUrl,
            knownOrgUrl: offer.offeredBy!,
          })
          .getOne()) || undefined;
      if (
        lastKnownRecord === undefined ||
        lastKnownRecord.lastSeenAtUTC < offerTimestamp
      ) {
        const knownOfferingOrg = new KnownOfferingOrg();
        knownOfferingOrg.hostOrgUrl = hostOrgUrl;
        knownOfferingOrg.orgUrl = offer.offeredBy!;
        knownOfferingOrg.lastSeenAtUTC = offerTimestamp;
        await t.em.save(knownOfferingOrg);
      }
    }

    const decodedChain = reshareChain ? decodeChain(reshareChain) : undefined;
    const bestStoredAcceptChain = await t.em.findOneBy(StoredReshareChain, {
      offerId: offer.id,
      postingOrgUrl: offer.offeredBy!,
      forUse: 'ACCEPT',
    });
    let replacedChain = false;
    if (
      compareReshareChainsForAccept(
        decodedChain,
        bestStoredAcceptChain
          ? bestStoredAcceptChain.decodedReshareChain
          : undefined
      ) < 0
    ) {
      if (reshareChain !== undefined) {
        const newAcceptChain = new StoredReshareChain();
        newAcceptChain.offerId = offer.id;
        newAcceptChain.hostOrgUrl = hostOrgUrl;
        newAcceptChain.postingOrgUrl = offer.offeredBy!;
        newAcceptChain.forUse = 'ACCEPT';
        newAcceptChain.reshareChain = reshareChain;
        newAcceptChain.decodedReshareChain = decodedChain!;
        newAcceptChain.length = reshareChain.length;
        await t.em.save(newAcceptChain);
      }
      replacedChain = true;
    }
    const bestStoredShareChain = await t.em.findOneBy(StoredReshareChain, {
      offerId: offer.id,
      postingOrgUrl: offer.offeredBy!,
      forUse: 'RESHARE',
    });
    if (
      compareReshareChainsForReshare(
        decodedChain,
        bestStoredShareChain
          ? bestStoredShareChain.decodedReshareChain
          : undefined
      ) < 0
    ) {
      if (reshareChain !== undefined) {
        const newReshareChain = new StoredReshareChain();
        newReshareChain.hostOrgUrl = hostOrgUrl;
        newReshareChain.offerId = offer.id;
        newReshareChain.postingOrgUrl = offer.offeredBy!;
        newReshareChain.forUse = 'RESHARE';
        newReshareChain.reshareChain = reshareChain;
        newReshareChain.decodedReshareChain = decodedChain!;
        newReshareChain.length = reshareChain.length;
        await t.em.save(newReshareChain);
      }
      replacedChain = true;
    }
    const isAdd = bestSnapshotUpdateTime === undefined;
    const isOfferUpdate =
      bestSnapshotUpdateTime !== undefined &&
      bestSnapshotUpdateTime < offerTimestamp;
    if (isAdd) {
      return 'ADD';
    } else if (isOfferUpdate || replacedChain) {
      return 'UPDATE';
    } else {
      return 'NONE';
    }
  }

  private async getNewestSnapshotTimestamp(
    t: SqlTransaction,
    hostOrgUrl: string,
    offerId: string,
    postingOrgUrl: string
  ): Promise<number | undefined> {
    const bestSnapshotInfo = await t.em
      .getRepository(CorpusOffer)
      .createQueryBuilder('corpusoffers')
      .select('MAX(corpusoffers.lastUpdateUTC)', 'lastUpdateUTC')
      .where('corpusoffers.offerId = :offerId')
      .andWhere('corpusoffers.postingOrgUrl = :postingOrgUrl')
      .andWhere('corpusoffers.hostOrgUrl = :hostOrgUrl')
      .setParameters({
        offerId: offerId,
        hostOrgUrl: hostOrgUrl,
        postingOrgUrl: postingOrgUrl,
      })
      .getRawOne();
    return bestSnapshotInfo.lastUpdateUTC === null
      ? undefined
      : parseInt(bestSnapshotInfo.lastUpdateUTC);
  }

  async getBestReshareChainRoot(
    t: SqlTransaction,
    offerId: string,
    postingOrgUrl: string
  ): Promise<ReshareChain | undefined> {
    return (
      await t.em.findOneBy(StoredReshareChain, {
        offerId: offerId,
        postingOrgUrl: postingOrgUrl,
        forUse: 'RESHARE',
      })
    )?.reshareChain;
  }

  async getBestAcceptChain(
    t: SqlTransaction,
    offerId: string,
    postingOrgUrl: string
  ): Promise<ReshareChain | undefined> {
    const reshareChain = (
      await t.em.findOneBy(StoredReshareChain, {
        offerId: offerId,
        postingOrgUrl: postingOrgUrl,
        forUse: 'ACCEPT',
      })
    )?.reshareChain;
    return reshareChain;
  }

  async deleteOfferInCorpus(
    t: SqlTransaction,
    hostOrgUrl: string,
    corpusOrgUrl: string,
    offerId: string,
    offeringOrgUrl: string
  ): Promise<PersistentStorageUpdateType> {
    await t.em.getRepository(CorpusOffer).delete({
      offerId: offerId,
      postingOrgUrl: offeringOrgUrl,
      corpusOrgUrl: corpusOrgUrl,
    });
    const remainingReferenceCount = await t.em
      .getRepository(CorpusOffer)
      .createQueryBuilder('corpusoffers')
      .where('corpusoffers.offerId = :offerId')
      .andWhere('corpusoffers.postingOrgUrl = :postingOrgUrl')
      .andWhere('corpusoffers.hostOrgUrl = :hostOrgUrl')
      .orderBy('corpusoffers.lastUpdateUTC')
      .setParameters({
        offerId: offerId,
        hostOrgUrl: hostOrgUrl,
        postingOrgUrl: offeringOrgUrl,
      })
      .getCount();
    // NOTE: If ANY corpus is publishing any version of an offer, this
    // implementation will not consider the offer deleted.
    if (remainingReferenceCount === 0) {
      return 'DELETE';
    } else {
      return 'NONE';
    }
  }

  async *getCorpusOffers(
    t: SqlTransaction,
    hostOrgUrl: string,
    corpusOrgUrl: string,
    skipCount = 0
  ): AsyncGenerator<Offer> {
    let selectPage;
    let cursorPos = skipCount;
    do {
      const query = t.em
        .getRepository(CorpusOffer)
        .createQueryBuilder('corpusoffers')
        .leftJoinAndSelect('corpusoffers.snapshot', 'snapshot')
        .where('corpusoffers.corpusOrgUrl = :orgUrl')
        .andWhere('corpusoffers.hostOrgUrl = :hostOrgUrl')
        .orderBy('corpusoffers.postingOrgUrl', 'ASC')
        .addOrderBy('corpusoffers.offerId', 'ASC')
        .setParameters({
          orgUrl: corpusOrgUrl,
          hostOrgUrl: hostOrgUrl,
        })
        .skip(cursorPos)
        .take(this.selectPageSize);
      selectPage = await query.getMany();
      for (const corpusOffer of selectPage) {
        yield corpusOffer.snapshot.offer;
      }
      cursorPos += this.selectPageSize;
    } while (
      selectPage &&
      selectPage.length &&
      selectPage.length >= this.selectPageSize
    );
  }

  async *getTimelineForOffer(
    t: SqlTransaction,
    hostOrgUrl: string,
    offerId: string,
    postingOrgUrl: string,
    queryInterval?: Interval,
    targetOrgUrl?: string
  ): AsyncGenerator<TimelineEntry> {
    let selectPage;
    let cursorPos = 0;
    let queryBase = t.em
      .getRepository(StoredTimelineEntry)
      .createQueryBuilder('timelineentry')
      .where('timelineentry.snapshot.offerId = :offerId')
      .andWhere('timelineentry.snapshot.postingOrgUrl = :postingOrgUrl')
      .andWhere('timelineentry.hostOrgUrl = :hostOrgUrl');
    if (queryInterval) {
      queryBase = queryBase
        .andWhere('timelineentry.startTimeUTC < :intervalEnd')
        .andWhere('timelineentry.endTimeUTC > :intervalStart');
    }
    if (targetOrgUrl) {
      queryBase = queryBase.andWhere(
        'timelineentry.targetOrganizationUrl = :targetOrgUrl'
      );
    }
    do {
      const query = queryBase
        .orderBy('timelineentry.startTimeUTC', 'ASC')
        .addOrderBy('timelineentry.snapshot.postingOrgUrl', 'ASC')
        .addOrderBy('timelineentry.snapshot.offerId', 'ASC')
        .setParameters({
          offerId: offerId,
          postingOrgUrl: postingOrgUrl,
          intervalStart: queryInterval?.startTimeUTC,
          intervalEnd: queryInterval?.endTimeUTC,
          targetOrgUrl: targetOrgUrl,
          hostOrgUrl: hostOrgUrl,
        })
        .skip(cursorPos)
        .take(this.selectPageSize);
      selectPage = await query.getMany();
      for (const entry of selectPage) {
        yield {
          targetOrganizationUrl: entry.targetOrganizationUrl,
          offerId: entry.snapshotOfferId,
          postingOrgUrl: entry.snapshotPostingOrgUrl,
          offerUpdateTimestampUTC: entry.snapshotLastUpdateUTC,
          startTimeUTC: entry.startTimeUTC,
          endTimeUTC: entry.endTimeUTC,
          isReservation: entry.isReservation,
          reshareChain: entry.reshareChain,
        };
      }
      cursorPos += this.selectPageSize;
    } while (
      selectPage &&
      selectPage.length &&
      selectPage.length >= this.selectPageSize
    );
  }

  async addTimelineEntries(
    t: SqlTransaction,
    hostOrgUrl: string,
    timelineEntries: AsyncIterable<TimelineEntry>
  ): Promise<void> {
    for await (const timelineEntry of timelineEntries) {
      const savedEntry = new StoredTimelineEntry();
      savedEntry.hostOrgUrl = hostOrgUrl;
      savedEntry.targetOrganizationUrl = timelineEntry.targetOrganizationUrl;
      savedEntry.startTimeUTC = timelineEntry.startTimeUTC;
      savedEntry.endTimeUTC = timelineEntry.endTimeUTC;
      savedEntry.isReservation = timelineEntry.isReservation;
      savedEntry.reshareChain = timelineEntry.reshareChain;
      savedEntry.snapshotPostingOrgUrl = timelineEntry.postingOrgUrl;
      savedEntry.snapshotOfferId = timelineEntry.offerId;
      savedEntry.snapshotLastUpdateUTC = timelineEntry.offerUpdateTimestampUTC;
      await t.em.save(savedEntry);
    }
  }

  async truncateFutureTimelineForOffer(
    t: SqlTransaction,
    hostOrgUrl: string,
    offerId: string,
    postingOrgUrl: string,
    timestampUTC: number
  ): Promise<void> {
    const overlappingEntries = await t.em
      .getRepository(StoredTimelineEntry)
      .createQueryBuilder('timelineentry')
      .where('timelineentry.snapshot.offerId = :offerId')
      .andWhere('timelineentry.snapshot.postingOrgUrl = :postingOrgUrl')
      .andWhere('timelineentry.startTimeUTC <= :timestampUTC')
      .andWhere('timelineentry.endTimeUTC > :timestampUTC')
      .andWhere('timelineentry.hostOrgUrl = :hostOrgUrl')
      .setParameters({
        offerId: offerId,
        hostOrgUrl: hostOrgUrl,
        timestampUTC: timestampUTC,
        postingOrgUrl: postingOrgUrl,
      })
      .getMany();
    for (const entry of overlappingEntries) {
      entry.endTimeUTC = timestampUTC;
      await t.em.save(entry);
    }
    await t.em
      .createQueryBuilder()
      .delete()
      .from(StoredTimelineEntry)
      .where('startTimeUTC >= :timestampUTC')
      .andWhere('snapshot.offerId = :offerId')
      .andWhere('snapshot.postingOrgUrl = :postingOrgUrl')
      .andWhere('hostOrgUrl = :hostOrgUrl')
      .setParameters({
        offerId: offerId,
        hostOrgUrl: hostOrgUrl,
        timestampUTC: timestampUTC,
        postingOrgUrl: postingOrgUrl,
      })
      .execute();
  }

  async *getChangedOffers(
    t: SqlTransaction,
    hostOrgUrl: string,
    viewingOrgUrl: string,
    oldTimestampUTC: number,
    newTimestampUTC: number,
    skipCount?: number
  ): AsyncGenerator<OfferVersionPair> {
    let selectPage;
    let cursorPos = skipCount ?? 0;
    const diffQueryBase = t.em
      .createQueryBuilder()
      .select('oldtimelineentries.offer', 'oldoffer')
      .addSelect('newtimelineentries.offer', 'newoffer')
      .from(qb => {
        return qb
          .select('snapshot.offer', 'offer')
          .addSelect('timelineentry.snapshot.offerId')
          .addSelect('timelineentry.snapshot.postingOrgUrl')
          .addSelect('timelineentry.snapshot.lastUpdateUTC')
          .distinctOn([
            'timelineentry.snapshot.offerId',
            'timelineentry.snapshot.postingOrgUrl',
            'timelineentry.snapshot.lastUpdateUTC',
          ])
          .from(StoredTimelineEntry, 'timelineentry')
          .leftJoin('timelineentry.snapshot', 'snapshot')
          .where(
            new Brackets(qb => {
              qb.where(
                'timelineentry.targetOrganizationUrl = :viewingOrgUrl'
              ).orWhere('timelineentry.targetOrganizationUrl = :wildcard');
            })
          )
          .andWhere('timelineentry.hostOrgUrl = :hostOrgUrl')
          .andWhere('timelineentry.startTimeUTC <= :oldTimestampUTC')
          .andWhere('timelineentry.endTimeUTC > :oldTimestampUTC');
      }, 'oldtimelineentries')
      // TODO(johndayrichter): The "innerJoin" below is really an outer join.
      // Remove this when TypeORM supports outer joins.
      .innerJoin(
        qb => {
          return qb
            .select('snapshot.offer', 'offer')
            .addSelect('timelineentry.snapshot.offerId')
            .addSelect('timelineentry.snapshot.postingOrgUrl')
            .addSelect('timelineentry.snapshot.lastUpdateUTC')
            .distinctOn([
              'timelineentry.snapshot.offerId',
              'timelineentry.snapshot.postingOrgUrl',
              'timelineentry.snapshot.lastUpdateUTC',
            ])
            .from(StoredTimelineEntry, 'timelineentry')
            .leftJoin('timelineentry.snapshot', 'snapshot')
            .where(
              new Brackets(qb => {
                qb.where(
                  'timelineentry.targetOrganizationUrl = :viewingOrgUrl'
                ).orWhere('timelineentry.targetOrganizationUrl = :wildcard');
              })
            )
            .andWhere('timelineentry.hostOrgUrl = :hostOrgUrl')
            .andWhere('timelineentry.startTimeUTC <= :newTimestampUTC')
            .andWhere('timelineentry.endTimeUTC > :newTimestampUTC');
        },
        'newtimelineentries',
        '"newtimelineentries"."snapshotOfferId" = ' +
          '"oldtimelineentries"."snapshotOfferId" AND ' +
          '"newtimelineentries"."snapshotPostingOrgUrl" = ' +
          '"oldtimelineentries"."snapshotPostingOrgUrl"'
      )
      .where(
        new Brackets(qb => {
          return qb
            .where(
              '"oldtimelineentries"."snapshotLastUpdateUTC" != ' +
                '"newtimelineentries"."snapshotLastUpdateUTC"'
            )
            .orWhere(
              '("oldtimelineentries"."snapshotLastUpdateUTC" IS NULL) ' +
                '!= ("newtimelineentries"."snapshotLastUpdateUTC" IS NULL)'
            );
        })
      )
      .orderBy(
        'COALESCE("oldtimelineentries"."snapshotPostingOrgUrl",' +
          '"newtimelineentries"."snapshotPostingOrgUrl")',
        'ASC'
      )
      .addOrderBy(
        'COALESCE("oldtimelineentries"."snapshotOfferId",' +
          '"newtimelineentries"."snapshotOfferId")',
        'ASC'
      )
      .addOrderBy(
        'COALESCE("oldtimelineentries"."snapshotLastUpdateUTC", ' +
          '"newtimelineentries"."snapshotLastUpdateUTC")',
        'DESC'
      )
      .setParameters({
        hostOrgUrl: hostOrgUrl,
        viewingOrgUrl: viewingOrgUrl,
        oldTimestampUTC: oldTimestampUTC,
        newTimestampUTC: newTimestampUTC,
        wildcard: '*',
      });
    do {
      const query = diffQueryBase.skip(cursorPos).take(this.selectPageSize);
      const queryAndParams = query.getQueryAndParameters();
      // TODO(johndayrichter): The following is perhaps the ugliest hack I've
      // written in 25 years of professional coding. Remove this abomination the
      // moment TypeORM supports outer joins. :(
      const querySql = queryAndParams[0].replace('INNER', 'FULL');
      selectPage = (await t.em.query(querySql, queryAndParams[1])) as Record<
        string,
        string
      >[];
      for (const entry of selectPage) {
        const oldOffer = entry.oldoffer
          ? JSON.parse(entry.oldoffer)
          : undefined;
        const newOffer = entry.newoffer
          ? JSON.parse(entry.newoffer)
          : undefined;
        const result = {
          oldVersion: oldOffer,
          newVersion: newOffer,
        };
        yield result;
      }
      cursorPos += this.selectPageSize;
    } while (
      selectPage &&
      selectPage.length &&
      selectPage.length >= this.selectPageSize
    );
  }

  async *getOffersAtTime(
    t: SqlTransaction,
    hostOrgUrl: string,
    viewingOrgUrl: string,
    timestampUTC: number,
    skipCount = 0,
    pageSize = this.selectPageSize
  ): AsyncGenerator<Offer> {
    let selectPage;
    let cursorPos = skipCount;
    let lastOffer = undefined;
    do {
      selectPage = await t.em
        .getRepository(StoredTimelineEntry)
        .createQueryBuilder('timelineentry')
        .leftJoinAndSelect('timelineentry.snapshot', 'snapshot')
        .where(
          new Brackets(qb => {
            let brackets = qb.where(
              'timelineentry.targetOrganizationUrl = :viewingOrgUrl'
            );
            // The wildcard operator does not apply in requests by the host org
            // itself. The host org doesn't see its own offers when making a
            // timeline request, even if an offer is wildcard listed.
            if (hostOrgUrl !== viewingOrgUrl) {
              brackets = brackets.orWhere(
                'timelineentry.targetOrganizationUrl = :wildcard'
              );
            }
            return brackets;
          })
        )
        .andWhere('timelineentry.startTimeUTC <= :timestampUTC')
        .andWhere('timelineentry.endTimeUTC > :timestampUTC')
        .andWhere('timelineentry.hostOrgUrl = :hostOrgUrl')
        .orderBy('snapshot.postingOrgUrl', 'ASC')
        .addOrderBy('snapshot.offerId', 'ASC')
        .addOrderBy('snapshot.lastUpdateUTC', 'DESC')
        .setParameters({
          hostOrgUrl: hostOrgUrl,
          viewingOrgUrl: viewingOrgUrl,
          timestampUTC: timestampUTC,
          wildcard: '*',
        })
        .skip(cursorPos)
        .take(pageSize)
        .getMany();
      for (const entry of selectPage) {
        const offer = entry.snapshot.offer;
        // Because of wildcards, it's possible that the same offer might be
        // listed twice for the same organization; once for the explicit org
        // url, and once for the wildcard. If that happens, the two entries will
        // be next to each other in the stream. Therefore, if we see an offer
        // with the same posting org and id as the previous offer, we ignore
        // the later copy. Because the database query has a tertiary sort on
        // lastUpdateUTC, we can be sure the newest version of the offer will
        // occur first.
        if (
          lastOffer?.id === offer.id &&
          lastOffer?.offeredBy === offer.offeredBy
        ) {
          continue;
        }
        offer.reshareChain = entry.reshareChain;
        yield offer;
        lastOffer = offer;
      }
      cursorPos += pageSize;
    } while (selectPage && selectPage.length && selectPage.length >= pageSize);
  }

  async getOfferAtTime(
    t: SqlTransaction,
    hostOrgUrl: string,
    viewingOrgUrl: string,
    offerId: string,
    postingOrgUrl: string,
    timestampUTC: number
  ): Promise<Offer | undefined> {
    const timelineEntry = await t.em
      .getRepository(StoredTimelineEntry)
      .createQueryBuilder('timelineentry')
      .leftJoinAndSelect('timelineentry.snapshot', 'snapshot')
      .where(
        new Brackets(qb => {
          qb.where(
            'timelineentry.targetOrganizationUrl = :viewingOrgUrl'
          ).orWhere('timelineentry.targetOrganizationUrl = :wildcard');
        })
      )
      .andWhere('timelineentry.snapshot.offerId = :offerId')
      .andWhere('timelineentry.snapshot.postingOrgUrl = :postingOrgUrl')
      .andWhere('timelineentry.startTimeUTC <= :timestampUTC')
      .andWhere('timelineentry.endTimeUTC > :timestampUTC')
      .andWhere('timelineentry.hostOrgUrl = :hostOrgUrl')
      .orderBy('snapshot.postingOrgUrl', 'ASC')
      .addOrderBy('snapshot.offerId', 'ASC')
      .addOrderBy('snapshot.lastUpdateUTC', 'DESC')
      .setParameters({
        hostOrgUrl: hostOrgUrl,
        viewingOrgUrl: viewingOrgUrl,
        timestampUTC: timestampUTC,
        offerId: offerId,
        postingOrgUrl: postingOrgUrl,
        wildcard: '*',
      })
      .getOne();
    return timelineEntry ? timelineEntry.snapshot.offer : undefined;
  }

  async writeAccept(
    t: SqlTransaction,
    hostOrgUrl: string,
    acceptingOrgUrl: string,
    offerId: string,
    offerUpdateTimestampUTC: number,
    atTimeUTC: number,
    decodedReshareChain?: DecodedReshareChain | undefined
  ): Promise<void> {
    const offer = await this.getOfferAtTime(
      t,
      hostOrgUrl,
      acceptingOrgUrl,
      offerId,
      hostOrgUrl,
      atTimeUTC
    );
    if (!offer) {
      throw new StatusError(
        'Unknown offer ' + offerId,
        'ERROR_ACCEPT_UNKNOWN_OFFER',
        404
      );
    }
    const acceptance = new StoredAcceptance();
    acceptance.acceptedBy = acceptingOrgUrl;
    acceptance.acceptedAtUTC = atTimeUTC;
    acceptance.snapshotOfferId = offerId;
    acceptance.snapshotPostingOrgUrl = hostOrgUrl;
    acceptance.snapshotLastUpdateUTC = getUpdateTimestamp(offer);
    acceptance.decodedReshareChain = decodedReshareChain;
    await t.em.save(acceptance);
    const viewerSet = new Set<string>();
    viewerSet.add(hostOrgUrl);
    viewerSet.add(acceptingOrgUrl);
    for (const x of decodedReshareChain || []) {
      viewerSet.add(x.sharingOrgUrl);
    }
    for (const viewingOrgUrl of viewerSet) {
      const historyViewer = new AcceptanceHistoryViewer();
      historyViewer.acceptance = acceptance;
      historyViewer.hostOrgUrl = hostOrgUrl;
      historyViewer.visibleToOrgUrl = viewingOrgUrl;
      await t.em.save(historyViewer);
    }
  }

  async *getHistory(
    t: SqlTransaction,
    hostOrgUrl: string,
    viewingOrgUrl: string,
    sinceTimestampUTC?: number | undefined,
    skipCount = 0
  ): AsyncIterable<OfferHistory> {
    let selectPage;
    let cursorPos = skipCount;
    let baseQuery = t.em
      .getRepository(AcceptanceHistoryViewer)
      .createQueryBuilder('historyviewer')
      .innerJoinAndSelect('historyviewer.acceptance', 'acceptance')
      .innerJoinAndSelect('acceptance.snapshot', 'snapshot')
      .where('historyviewer.visibleToOrgUrl = :viewingOrgUrl')
      .andWhere('historyviewer.hostOrgUrl = :hostOrgUrl');
    if (sinceTimestampUTC !== undefined) {
      baseQuery = baseQuery.andWhere(
        'acceptance.acceptedAtUTC >= :sinceTimestampUTC'
      );
    }
    do {
      selectPage = await baseQuery
        .setParameters({
          hostOrgUrl: hostOrgUrl,
          viewingOrgUrl: viewingOrgUrl,
          sinceTimestampUTC: sinceTimestampUTC,
        })
        .skip(cursorPos)
        .take(this.selectPageSize)
        .getMany();
      for (const historyviewer of selectPage) {
        const offerHistory = {
          acceptedAtUTC: historyviewer.acceptance.acceptedAtUTC,
          acceptingOrganization: historyviewer.acceptance.acceptedBy,
          offer: historyviewer.acceptance.snapshot.offer,
          decodedReshareChain: historyviewer.acceptance.decodedReshareChain,
        } as OfferHistory;
        yield offerHistory;
      }
      cursorPos += this.selectPageSize;
    } while (
      selectPage &&
      selectPage.length &&
      selectPage.length >= this.selectPageSize
    );
  }

  async writeReject(
    t: SqlTransaction,
    hostOrgUrl: string,
    rejectingOrgUrl: string,
    offerId: string,
    postingOrgUrl: string,
    atTimeUTC: number
  ): Promise<void> {
    const rejection = new StoredRejection();
    rejection.hostOrgUrl = hostOrgUrl;
    rejection.rejectingOrgUrl = rejectingOrgUrl;
    rejection.offerId = offerId;
    rejection.postingOrgUrl = postingOrgUrl;
    rejection.rejectedAtUTC = atTimeUTC;
    await t.em.save(rejection);
  }

  async getAllRejections(
    t: SqlTransaction,
    hostOrgUrl: string,
    offerId: string,
    postingOrgUrl: string
  ): Promise<string[]> {
    const rejections = await t.em
      .getRepository(StoredRejection)
      .createQueryBuilder('rejections')
      .where('rejections.hostOrgUrl = :hostOrgUrl')
      .andWhere('rejections.offerId = :offerId')
      .andWhere('rejections.postingOrgUrl = :postingOrgUrl')
      .orderBy('rejections.postingOrgUrl', 'ASC')
      .addOrderBy('rejections.offerId', 'ASC')
      .setParameters({
        hostOrgUrl: hostOrgUrl,
        offerId: offerId,
        postingOrgUrl: postingOrgUrl,
      })
      .getMany();
    return rejections.map(x => x.rejectingOrgUrl);
  }

  async *getKnownOfferingOrgs(
    t: SqlTransaction,
    hostOrgUrl: string,
    sinceTimestampUTC?: number | undefined
  ): AsyncGenerator<string> {
    let selectPage;
    let cursorPos = 0;
    let query = t.em
      .getRepository(KnownOfferingOrg)
      .createQueryBuilder('knownorgs')
      .andWhere('knownorgs.hostOrgUrl = :hostOrgUrl');
    if (sinceTimestampUTC !== undefined) {
      query = query.andWhere('knownorgs.lastSeenAt >= :timestampUTC');
    }
    query = query
      .orderBy('knownorgs.lastSeenAtUTC', 'DESC')
      .addOrderBy('knownorgs.orgUrl', 'ASC');

    do {
      selectPage = await query
        .setParameters({
          hostOrgUrl: hostOrgUrl,
        })
        .skip(cursorPos)
        .take(this.selectPageSize)
        .getMany();
      for (const entry of selectPage) {
        yield entry.orgUrl;
      }
      cursorPos += this.selectPageSize;
    } while (
      selectPage &&
      selectPage.length &&
      selectPage.length >= this.selectPageSize
    );
  }

  async writeOfferProducerMetadata(
    t: SqlTransaction,
    metadata: OfferProducerMetadata
  ): Promise<void> {
    const newMetadata = new ProducerMetadata();
    newMetadata.organizationUrl = metadata.organizationUrl;
    newMetadata.nextRunTimestampUTC = metadata.nextRunTimestampUTC;
    newMetadata.lastUpdateTimeUTC = metadata.lastUpdateTimeUTC;
    await t.em.getRepository(ProducerMetadata).save(newMetadata);
  }

  async getOfferProducerMetadata(
    t: SqlTransaction,
    orgUrl: string
  ): Promise<OfferProducerMetadata | undefined> {
    const storedMetadata = await t.em
      .getRepository(ProducerMetadata)
      .createQueryBuilder('producermetadata')
      .where('producermetadata.organizationUrl = :organizationUrl')
      .setParameters({
        organizationUrl: orgUrl,
      })
      .getOne();
    return storedMetadata
      ? {
          organizationUrl: storedMetadata.organizationUrl,
          nextRunTimestampUTC: storedMetadata.nextRunTimestampUTC,
          lastUpdateTimeUTC: storedMetadata.lastUpdateTimeUTC,
        }
      : undefined;
  }

  async debugQuery(t: SqlTransaction, sql: string): Promise<unknown> {
    return await t.em.query(sql);
  }
}
