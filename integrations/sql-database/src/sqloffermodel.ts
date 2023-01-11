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
  decodeChain,
  DefaultClock,
  diff,
  HandlerRegistration,
  intersect,
  loglevel,
  logCustom,
  Logger,
  OfferChange,
  OfferListingPolicy,
  OfferModel,
  OfferSetUpdate,
  Signer,
  StatusError,
  subtract,
  trim,
  updateInterval,
  OfferProducerMetadata,
  asyncIterableToArray,
  idToUrl,
  verifyDecodedChain,
} from 'opr-core';
import {
  ListOffersPayload,
  ListOffersResponse,
  ReshareChain,
  OfferHistory,
  Offer,
  DecodedReshareChain,
  AcceptOfferResponse,
  RejectOfferResponse,
  ReserveOfferResponse,
  HistoryPayload,
  HistoryResponse,
} from 'opr-models';
import {Brackets, DataSource, DataSourceOptions, EntityManager} from 'typeorm';
export {DataSourceOptions} from 'typeorm';
import {OfferSnapshot} from './model/offersnapshot';
import {TimelineEntry} from './model/timelineentry';
import {FeedCorpus} from './model/feedcorpus';
import {FeedCorpusOffer} from './model/feedcorpusoffer';
import {toOfferSet} from 'opr-core/build/diff';
import {Validator} from 'opr-models';
import {Acceptance} from './model/acceptance';
import {AcceptanceHistoryViewer} from './model/acceptancehistoryviewer';
import {KnownOfferingOrg} from './model/knownofferingorg';
import {ProducerMetadata} from './model/producermetadata';

type IsolationLevel =
  | 'READ UNCOMMITTED'
  | 'READ COMMITTED'
  | 'REPEATABLE READ'
  | 'SERIALIZABLE';

export interface SqlOfferModelOptions {
  clock?: Clock;
  dsOptions: DataSourceOptions;
  listingPolicy: OfferListingPolicy;
  signer: Signer;
  hostOrgUrl: string;
  enableInternalChecks?: boolean;
  logger?: Logger;
}

/**
 * Original OfferModel implementation that provides all storage and business
 * logic in one place. This approach is deprecated. New code should use
 * PersistentOfferModel, which separates business logic from storage
 * capabilities. This class will be deleted in a future release.
 * @deprecated
 */
export class SqlOfferModel implements OfferModel {
  private readonly db: DataSource;
  private initialized = false;
  private readonly clock: Clock;
  private readonly listingPolicy: OfferListingPolicy;
  private changeHandlers: Array<(change: OfferChange) => Promise<void>>;
  private signer: Signer;
  private hostOrgUrl: string;
  private enableInternalChecks: boolean;
  private logger: Logger;

  constructor(options: SqlOfferModelOptions) {
    const dsOptions = {
      ...options.dsOptions,
      entities: [
        Acceptance,
        AcceptanceHistoryViewer,
        FeedCorpus,
        FeedCorpusOffer,
        KnownOfferingOrg,
        OfferSnapshot,
        ProducerMetadata,
        TimelineEntry,
      ],
    };
    this.db = new DataSource(dsOptions);
    this.clock = options.clock || new DefaultClock();
    this.listingPolicy = options.listingPolicy;
    this.signer = options.signer;
    this.changeHandlers = [];
    this.hostOrgUrl = options.hostOrgUrl;
    this.enableInternalChecks = options.enableInternalChecks ?? false;
    this.logger = options.logger ?? loglevel.getLogger('SqlOprDatabase');
  }

  async initialize(): Promise<void> {
    if (!this.initialized) {
      await this.db.initialize();
      this.initialized = true;
    }
  }

  async shutdown(): Promise<void> {
    await this.db.destroy();
  }

  async synchronize(dropBeforeSync: boolean): Promise<void> {
    await this.db.synchronize(dropBeforeSync);
  }

  async writeOfferProducerMetadata(
    metadata: OfferProducerMetadata
  ): Promise<void> {
    await this.runInTransaction(async em => {
      const newMetadata = new ProducerMetadata();
      newMetadata.organizationUrl = metadata.organizationUrl;
      newMetadata.nextRunTimestampUTC = metadata.nextRunTimestampUTC;
      newMetadata.lastUpdateTimeUTC = metadata.lastUpdateTimeUTC;
      await em.getRepository(ProducerMetadata).save(newMetadata);
    });
  }

  async getOfferProducerMetadata(
    organizationUrl: string
  ): Promise<OfferProducerMetadata | undefined> {
    return await this.runInTransaction(async em => {
      const storedMetadata = await em
        .getRepository(ProducerMetadata)
        .createQueryBuilder('producermetadata')
        .where('producermetadata.organizationUrl = :organizationUrl')
        .setParameters({
          organizationUrl: organizationUrl,
        })
        .getOne();
      const now = this.clock.now();
      let metadata = storedMetadata;
      if (!metadata) {
        metadata = new ProducerMetadata();
        metadata.organizationUrl = organizationUrl;
        metadata.nextRunTimestampUTC = now;
        metadata.lastUpdateTimeUTC = now;
      }
      await em.getRepository(ProducerMetadata).save(metadata);
      return storedMetadata
        ? {
            organizationUrl: storedMetadata.organizationUrl,
            nextRunTimestampUTC: storedMetadata.nextRunTimestampUTC,
            lastUpdateTimeUTC: storedMetadata.lastUpdateTimeUTC,
          }
        : undefined;
    });
  }

  private async runInTransaction<T>(
    handlerFn: (entityManager: EntityManager) => Promise<T>,
    isolationLevel: IsolationLevel = 'SERIALIZABLE'
  ): Promise<T> {
    // Some databases don't support all isolation levels. Handle some well-known
    // problem cases.
    // See: https://orkhan.gitbook.io/typeorm/docs/transactions
    if (this.db.options.type === 'sqlite') {
      // SQL Lite only supports SERIALIZABLE transactions
      isolationLevel = 'SERIALIZABLE';
    } else if (this.db.options.type === 'oracle') {
      if (isolationLevel === 'READ UNCOMMITTED') {
        isolationLevel = 'READ COMMITTED';
      } else if (isolationLevel === 'REPEATABLE READ') {
        isolationLevel = 'SERIALIZABLE';
      }
    }
    try {
      return await this.db.manager.transaction(isolationLevel, handlerFn);
    } catch (e) {
      this.logger.error(e);
      throw new StatusError('Database error', 'ERROR_DATABASE', 500, e);
    }
  }

  async list(
    orgUrl: string,
    payload: ListOffersPayload
  ): Promise<ListOffersResponse> {
    return this.runInTransaction(
      em => this.handleListRequestInTransaction(em, orgUrl, payload),
      'READ COMMITTED'
    );
  }

  async handleListRequestInTransaction(
    entityManager: EntityManager,
    orgUrl: string,
    payload: ListOffersPayload
  ): Promise<ListOffersResponse> {
    const now = this.clock.now();
    if (
      payload.requestedResultFormat === 'DIFF' &&
      payload.diffStartTimestampUTC !== undefined
    ) {
      const firstSnapshot = await this.listOffersAtTime(
        entityManager,
        orgUrl,
        payload.diffStartTimestampUTC
      );
      const currentSnapshot = await this.listOffersAtTime(
        entityManager,
        orgUrl,
        now
      );
      const delta = diff.diffAsOfferPatches(firstSnapshot, currentSnapshot);
      // If the first snapshot is empty, it might mean that the first snapshot
      // request is so far back in time that we don't remember what the initial
      // state was. In that case, we want to send the caller an operation that
      // means "delete all offers you're holding before you apply this diff."
      // We can do that by adding a "replace" operation that wipes out the
      // entire root collection at the beginning of the diff. It's safe to do
      // this whenever the initial snapshot is empty.
      if (firstSnapshot.length === 0) {
        delta.unshift('clear');
      }
      return {
        responseFormat: 'DIFF',
        diff: delta,
        resultsTimestampUTC: now,
      } as ListOffersResponse;
    } else {
      const snapshot = await this.listOffersAtTime(entityManager, orgUrl, now);
      return {
        responseFormat: 'SNAPSHOT',
        offers: snapshot,
        resultsTimestampUTC: now,
      } as ListOffersResponse;
    }
  }

  async listOffersAtTime(
    entityManager: EntityManager,
    orgUrl: string,
    time: number
  ): Promise<Array<Offer>> {
    const timelineEntryQuery = await entityManager
      .getRepository(TimelineEntry)
      .createQueryBuilder('timelineentry')
      .leftJoinAndSelect('timelineentry.offer', 'offer')
      .where('timelineentry.startTimeUTC <= :time')
      .andWhere('timelineentry.endTimeUTC > :time')
      .andWhere(
        new Brackets(qb => {
          qb.where('timelineentry.targetOrganizationUrl = :org').orWhere(
            'timelineentry.targetOrganizationUrl = :wildcard'
          );
        })
      )
      .andWhere('timelineentry.isRejection = :isRejection')
      .orderBy('timelineentry.offer.lastUpdateUTC', 'ASC')
      .addOrderBy('timelineentry.offer.offerId', 'ASC')
      // A descending sort on org url length ensures that wildcard entries
      // occur last.
      .addOrderBy('LENGTH(timelineentry.targetOrganizationUrl)', 'DESC')
      .setParameters({
        time: time,
        org: orgUrl,
        isRejection: false,
        wildcard: '*',
      });

    const timelineEntries = await timelineEntryQuery.getMany();
    this.logger.debug(
      'retrieved timeline entries for',
      orgUrl,
      'at',
      time,
      ':',
      timelineEntries
    );
    const alreadySeenOfferIds = new Set<string>();
    const offers = [];
    for (const timelineEntry of timelineEntries) {
      const offer = timelineEntry.offer.offer;
      const fullId = idToUrl(offer, true);
      // The same offer may appear in the list twice if it is explicitly listed
      // for the current organization and the wildcard organization. If we see
      // an org id more than once, we only retain the first listing.
      if (alreadySeenOfferIds.has(fullId)) {
        continue;
      }
      alreadySeenOfferIds.add(fullId);
      if (timelineEntry.reshareChain) {
        offer.reshareChain = timelineEntry.reshareChain;
      }
      offers.push(offer);
    }
    return offers;
  }

  /**
   * Returns the timeline entry for the given offer, org and time. The offer is
   * identified by a combination of offer id and postingOrgUrl. If there is
   * no timeline entry for that offer, org and time, undefined is returned.
   */
  async getOfferTimelineEntryForOrg(
    entityManager: EntityManager,
    requestingOrgUrl: string,
    postingOrgUrl: string,
    offerId: string,
    time: number
  ): Promise<TimelineEntry | undefined> {
    const timelineEntryQuery = await entityManager
      .getRepository(TimelineEntry)
      .createQueryBuilder('timelineentry')
      .leftJoinAndSelect('timelineentry.offer', 'offer')
      .leftJoinAndSelect('offer.corpusOffers', 'corpusOffers')
      .where('timelineentry.startTimeUTC <= :time')
      .andWhere('timelineentry.endTimeUTC > :time')
      .andWhere('timelineentry.offer.offerId = :offerId')
      .andWhere('timelineentry.offer.postingOrgUrl = :postingOrgUrl')
      .andWhere(
        new Brackets(qb => {
          qb.where('timelineentry.targetOrganizationUrl = :org').orWhere(
            'timelineentry.targetOrganizationUrl = :wildcard'
          );
        })
      )
      .andWhere('timelineentry.isRejection = :isRejection')
      .orderBy('timelineentry.offer.lastUpdateUTC', 'ASC')
      .addOrderBy('timelineentry.offer.offerId', 'ASC')
      // A descending sort on org url length ensures that wildcard entries
      // occur last.
      .addOrderBy('LENGTH(timelineentry.targetOrganizationUrl)', 'DESC')
      .setParameters({
        time: time,
        org: requestingOrgUrl,
        offerId: offerId,
        postingOrgUrl: postingOrgUrl,
        isRejection: false,
        wildcard: '*',
      });

    return (await timelineEntryQuery.getOne()) || undefined;
  }

  async processUpdate(
    producerId: string,
    update: OfferSetUpdate
  ): Promise<void> {
    const changes = await this.runInTransaction(em =>
      this.processUpdateInTransaction(em, producerId, update)
    );
    for (const change of changes) {
      await this.fireChange(change);
    }
  }

  getAllOffers(): Promise<Array<Offer>> {
    return this.runInTransaction(async em => {
      return (await this.getAllSnapshots(em)).map(s => s.offer);
    });
  }

  private async getAllSnapshots(
    entityManager: EntityManager,
    now = this.clock.now()
  ): Promise<Array<OfferSnapshot>> {
    const liveSnapshotsQuery = entityManager
      .getRepository(OfferSnapshot)
      .createQueryBuilder('snapshots')
      .leftJoinAndSelect('snapshots.corpusOffers', 'corpusOffers')
      .innerJoin(
        qb => {
          return qb
            .select('offers.snapshot.offerId', 'offerId')
            .from(FeedCorpusOffer, 'offers')
            .addSelect('offers.snapshot.postingOrgUrl', 'postingOrgUrl')
            .addSelect('MAX(offers.snapshot.lastUpdateUTC)', 'maxTimeUTC')
            .innerJoin('offers.snapshot', 'snapshot')
            .innerJoin('offers.corpus', 'corpus', 'corpus.isLatest = true')
            .where('snapshot.expirationUTC > :now', {now: now})
            .groupBy('offers.snapshot.offerId')
            .addGroupBy('offers.snapshot.postingOrgUrl');
        },
        'currentSnapshots',
        'snapshots.offerId = "currentSnapshots"."offerId" AND ' +
          'snapshots.postingOrgUrl = "currentSnapshots"."postingOrgUrl" AND ' +
          'snapshots.lastUpdateUTC = "currentSnapshots"."maxTimeUTC"'
      );

    return await liveSnapshotsQuery.getMany();
  }

  /**
   * A helper method for process update that is guaranteed to be called inside
   * a transaction. If this method throws an error, the error will be caught
   * by the caller and will cause a database rollback.
   */
  private async processUpdateInTransaction(
    entityManager: EntityManager,
    producerId: string,
    update: OfferSetUpdate
  ): Promise<Array<OfferChange>> {
    this.logger.debug('Processing update', logCustom(update));
    const now = this.clock.now();
    const oldOfferList = [] as Array<Offer>;
    const lastCorpus = await entityManager
      .getRepository(FeedCorpus)
      .createQueryBuilder('corpus')
      .where('corpus.sourceFeed = :producerId')
      .andWhere('corpus.isLatest = true')
      .setParameter('producerId', producerId)
      .getOne();
    if (lastCorpus) {
      const entries = await entityManager.find(FeedCorpusOffer, {
        relations: {
          snapshot: true,
        },
        where: {
          corpus: {
            id: lastCorpus.id,
          },
        },
      });
      for (const oldEntry of entries) {
        const offer = oldEntry.snapshot.offer;
        oldOfferList.push(offer);
      }
    }
    const oldOfferMap = toOfferSet(oldOfferList);
    this.logger.debug('oldOfferMap', oldOfferMap);
    let newOfferMap;
    if (update.delta) {
      const patches = await asyncIterableToArray(update.delta!);
      this.logger.debug('patches', patches);
      newOfferMap = await diff.applyOfferPatchesAsMap(oldOfferList, patches);
    } else if (update.offers) {
      newOfferMap = diff.toOfferSet(await asyncIterableToArray(update.offers));
    } else {
      throw new StatusError(
        'Bad update set, neither delta nor offers specified',
        'INTERNAL_ERROR_BAD_UPDATE_SET',
        500
      );
    }
    newOfferMap = this.filterBadOffers(
      newOfferMap,
      producerId,
      update.sourceOrgUrl
    );
    this.logger.debug('newOfferMap', newOfferMap);
    const newCorpus = new FeedCorpus();
    newCorpus.recordedAtUTC = update.updateCurrentAsOfTimestampUTC;
    newCorpus.sourceFeed = producerId;
    newCorpus.isLatest = true;
    if (lastCorpus) {
      lastCorpus.isLatest = false;
      await entityManager.save(lastCorpus);
    }
    await entityManager.save(newCorpus);
    const snapshots = [];
    const corpusEntries = [];
    for (const offerId in newOfferMap) {
      const offer = newOfferMap[offerId];
      const reshareChain = offer.reshareChain;
      delete offer.reshareChain;
      const snapshot = new OfferSnapshot();
      snapshot.lastUpdateUTC = offer.offerUpdateUTC ?? offer.offerCreationUTC;
      snapshot.offerId = offer.id;
      snapshot.postingOrgUrl = offer.offeredBy!;
      snapshot.expirationUTC = offer.offerExpirationUTC;
      snapshot.offer = offer;
      snapshots.push(snapshot);
      const corpusEntry = new FeedCorpusOffer();
      corpusEntry.corpus = newCorpus;
      corpusEntry.snapshot = snapshot;
      corpusEntry.reshareChain = reshareChain;
      corpusEntries.push(corpusEntry);
    }
    await entityManager.save(snapshots);
    await entityManager.save(corpusEntries);
    // Get all the current snapshots
    const liveSnapshots = await this.getAllSnapshots(entityManager, now);
    this.logger.debug('liveSnapshots', liveSnapshots);
    const changes = new Array<OfferChange>();
    for (const snapshot of liveSnapshots) {
      // If one of the offers we just patched in is the newest version of the
      // offer, it means it was just updated. We need to generate new listings
      // for offers that have been updated.
      // First, check to see if the current snapshot was in the new offer map
      // at all. If it's not, it hasn't changed with this update.
      const fullOfferId = idToUrl(snapshot.offer, true);
      const newOffer = newOfferMap[fullOfferId];
      if (!newOffer) {
        continue;
      }
      // Next, check to see if the current snapshot has the same update time as
      // the newly updated offer. If it doesn't, the offer was updated but we
      // have a newer snapshot from another source, so we don't update the
      // listings.
      const newOfferUpdateTime =
        newOffer.offerUpdateUTC || newOffer.offerCreationUTC;
      if (newOfferUpdateTime !== snapshot.lastUpdateUTC) {
        continue;
      }
      const oldOffer = oldOfferMap[fullOfferId];
      if (oldOffer) {
        const oldOfferUpdateTime =
          oldOffer.offerUpdateUTC || oldOffer.offerCreationUTC;
        // Check to see if the new offer update time is the same as the old
        // offer update time. If it is, this offer was mentioned in the latest
        // corpus update, but nothing has changed. We should skip this offer.
        if (oldOfferUpdateTime === newOfferUpdateTime) {
          continue;
        }
      }
      // At this point, we're sure this offer has been updated. Update the
      // listings for this offer.
      await this.updateListingsWithTransaction(entityManager, snapshot, now);
      // Record a change notification
      if (oldOffer) {
        changes.push({
          type: 'UPDATE',
          timestampUTC: now,
          oldValue: oldOffer,
          newValue: newOffer,
        });
      } else {
        changes.push({
          type: 'ADD',
          timestampUTC: now,
          newValue: newOffer,
        });
      }
    }
    // Detect deletions
    for (const oldOffer of oldOfferList) {
      const fullOfferId = idToUrl(oldOffer, true);
      if (!newOfferMap[fullOfferId]) {
        this.logger.debug('Detected deletion of', fullOfferId);
        await this.deleteFutureTimelineEntriesWithTransaction(
          entityManager,
          oldOffer.id,
          oldOffer.offeredBy!,
          now
        );
        changes.push({
          type: 'DELETE',
          timestampUTC: now,
          oldValue: oldOffer,
        });
      }
    }
    return changes;
  }

  private filterBadOffers(
    offerMap: Record<string, Offer>,
    producerId: string,
    sourceOrgUrl: string
  ): Record<string, Offer> {
    const filteredMap = {} as Record<string, Offer>;
    for (const offerId in offerMap) {
      const offer = offerMap[offerId];
      try {
        Validator.validate(offer, 'offer.schema.json');
      } catch (e) {
        this.logger.warn(
          'Discarded malformed offer from producer',
          producerId,
          ':',
          JSON.stringify(offer),
          e
        );
        continue;
      }
      if (offer.offeredBy !== sourceOrgUrl && !offer.reshareChain) {
        this.logger.warn(
          'Discarded secondhand offer without reshare chain',
          JSON.stringify(offer)
        );
        continue;
      }
      if (offer.reshareChain) {
        const decodedChain = decodeChain(offer.reshareChain);
        try {
          verifyDecodedChain(decodedChain, {
            initialEntitlements: offer.id,
            finalSubject: this.hostOrgUrl,
            initialIssuer: offer.offeredBy!,
          });
        } catch (e) {
          this.logger.warn(
            'Discarded offer with bad reshare chain from producer',
            producerId,
            ':',
            JSON.stringify(offer),
            e
          );
          continue;
        }
      }
      filteredMap[offerId] = offer;
    }
    return filteredMap;
  }

  private async updateListingsWithTransaction(
    entityManager: EntityManager,
    snapshot: OfferSnapshot,
    now: number
  ): Promise<void> {
    this.logger.debug(
      'Updating listings for',
      snapshot.offerId,
      snapshot.postingOrgUrl
    );
    // Collect and decode all reshare chains that mention this offer, including
    // undefined reshare chains (which means the offer was shared with this
    // server directly).
    const reshareChains = snapshot.corpusOffers.map(co => co.reshareChain);
    const decodedChains = reshareChains.map(chain =>
      chain ? decodeChain(chain) : chain
    );

    // Find out who has rejected the offer at this point. We need this
    // information to generate listings.
    const rejections = new Set(
      (
        await this.getCurrentRejectionsWithTransaction(
          entityManager,
          snapshot.offerId,
          snapshot.postingOrgUrl,
          now
        )
      ).map(entry => entry.targetOrganizationUrl)
    );

    // TODO: Look up whether the offer was accepted... Or just don't allow
    // accepted offers to be updated.
    const isAccepted = false;
    const timelineEntries = [];
    if (!isAccepted) {
      // Build new timeline entries for this offer. All of these entries start
      // at the current instant.
      timelineEntries.push(
        ...(await this.generateLocalServerTimelineEntriesWithTransaction(
          entityManager,
          snapshot,
          reshareChains,
          decodedChains,
          rejections,
          now
        ))
      );
      timelineEntries.push(
        ...(await this.generateRemoteServerTimelineEntriesWithTransaction(
          entityManager,
          snapshot,
          reshareChains,
          decodedChains,
          rejections,
          now
        ))
      );
    }

    if (this.enableInternalChecks) {
      this.checkTimelineEntries(timelineEntries);
    }
    await this.deleteFutureTimelineEntriesWithTransaction(
      entityManager,
      snapshot.offerId,
      snapshot.postingOrgUrl,
      now
    );
    this.logger.debug('generated timeline entries:', timelineEntries);
    // Write the new timeline entries for the future.
    if (timelineEntries.length) {
      await entityManager.getRepository(TimelineEntry).save(timelineEntries);
    }
  }

  private async deleteFutureTimelineEntriesWithTransaction(
    entityManager: EntityManager,
    offerId: string,
    postingOrgUrl: string,
    now: number
  ): Promise<void> {
    // Truncate any active timeline entries so that they end now.
    await this.truncateLiveTimelineEntriesWithTransaction(
      entityManager,
      offerId,
      postingOrgUrl,
      now
    );

    // Delete all timeline entries that are entirely in the future. We're
    // going to rewrite all of them.
    const deleteQuery = entityManager
      .createQueryBuilder()
      .delete()
      .from(TimelineEntry)
      .where('offer.offerId = :offerId', {
        offerId: offerId,
      })
      .andWhere('offer.postingOrgUrl = :postingOrgUrl', {
        postingOrgUrl: postingOrgUrl,
      })
      .andWhere('startTimeUTC > :now', {now: now});
    await deleteQuery.execute();
  }

  private async generateLocalServerTimelineEntriesWithTransaction(
    entityManager: EntityManager,
    snapshot: OfferSnapshot,
    reshareChains: Array<ReshareChain | undefined>,
    decodedChains: Array<DecodedReshareChain | undefined>,
    rejections: Set<string>,
    now: number
  ): Promise<TimelineEntry[]> {
    const offer = snapshot.offer;
    // We can't accept offers from ourselves.
    if (this.hostOrgUrl === offer.offeredBy) {
      return [];
    }

    // Figure out whether the local server can accept this offer, and if so,
    // pick the best reshare chain for accepting it (which might be undefined)
    let bestLocalAcceptChain: ReshareChain | undefined;
    let canAcceptLocally = false;
    if (this.hostOrgUrl !== snapshot.offer.offeredBy) {
      const bestLocalAcceptChainIndex =
        this.findBestLocalAcceptChainIndex(decodedChains);
      bestLocalAcceptChain =
        bestLocalAcceptChainIndex >= 0
          ? reshareChains[bestLocalAcceptChainIndex]
          : undefined;
      canAcceptLocally = bestLocalAcceptChainIndex >= 0;
    }

    // We couldn't find a reshare chain that was undefined or ended in an
    // accept permission.
    if (!canAcceptLocally) {
      return [];
    }
    const timelineEntry = new TimelineEntry();
    timelineEntry.offer = snapshot;
    timelineEntry.targetOrganizationUrl = this.hostOrgUrl;
    timelineEntry.startTimeUTC = now;
    timelineEntry.endTimeUTC = offer.offerExpirationUTC;
    timelineEntry.reshareChain = bestLocalAcceptChain;
    return [timelineEntry];
  }

  private async generateRemoteServerTimelineEntriesWithTransaction(
    entityManager: EntityManager,
    snapshot: OfferSnapshot,
    reshareChains: Array<ReshareChain | undefined>,
    decodedChains: Array<DecodedReshareChain | undefined>,
    rejections: Set<string>,
    now: number
  ): Promise<TimelineEntry[]> {
    const offer = snapshot.offer;
    // Pick the best reshare chain to use for this offer, if any exists. Use
    // that reshare chain (and other information) to figure out whether any
    // remote servers can accept this offer.
    let bestReshareChainRoot: ReshareChain | undefined;
    if (this.hostOrgUrl === offer.offeredBy!) {
      bestReshareChainRoot = [];
    } else {
      const bestReshareChainRootIndex =
        this.findBestReshareChainIndex(decodedChains);
      bestReshareChainRoot =
        bestReshareChainRootIndex >= 0
          ? reshareChains[bestReshareChainRootIndex]
          : undefined;
    }

    // If there's no reshare chain root, it means that the offer didn't
    // originate with this server and the offer doesn't have a reshare chain.
    // We can't show it to any other server, so we create no remote timeline
    // entries for it.
    if (bestReshareChainRoot === undefined) {
      return [];
    }

    // Collect the organizations that have already shared this offer. We
    // shouldn't show it to them again.
    const sharedBy = new Set<string>(
      decodedChains
        .flatMap(dc => dc?.map(link => link.sharingOrgUrl))
        .filter(x => x !== undefined) as Array<string>
    );
    sharedBy.add(snapshot.offer.offeredBy!);

    // See if this offer is currenly reserved. If it is, we need to do some
    // special handling of generated listings.
    const reservation = await this.getCurrentReservationWithTransaction(
      entityManager,
      offer.id,
      offer.offeredBy!,
      now
    );

    // Find the first time we ever listed this offer. This is a required
    // piece of information for listing generation.
    const firstListingTimeStruct = await entityManager
      .getRepository(TimelineEntry)
      .createQueryBuilder('timelineentries')
      .select('MIN(timelineentries.startTimeUTC)', 'firstTime')
      .where('timelineentries.offer.offerId = :offerId', {
        offerId: offer.id,
      })
      .andWhere('timelineentries.offer.postingOrgUrl = :postingOrgUrl', {
        postingOrgUrl: offer.offeredBy!,
      })
      .getRawOne();
    const firstListingTime = firstListingTimeStruct.firstTime ?? now;
    const rawListings = await this.listingPolicy.getListings(
      offer,
      firstListingTime,
      now,
      rejections,
      sharedBy
    );

    // Trim the new listings to begin now. Listings that are entirely in the
    // past will be trimmed to zero duration and are discarded.
    const listings = [];
    for (const listing of rawListings) {
      const newInterval = trim(listing, {startAt: now});
      if (newInterval) {
        updateInterval(listing, newInterval);
        listings.push(listing);
      }
    }
    // If there's a reservation held on the current offer, we need to
    // determine whether the organization that currently holds the reservation
    // still has an active listing. If it does, we create a new timeline entry
    // for the new version of the reservation.
    let newReservation;
    if (reservation) {
      for (const listing of listings) {
        // Ignore listings for organizations that aren't the reservation holder.
        if (listing.orgUrl !== reservation!.targetOrganizationUrl) {
          continue;
        }
        // Find when the listing overlaps the reservation.
        const intersection = intersect(reservation!, listing);
        // If the listing overlaps the reservation and starts NOW, that listing
        // can extend the current reservation.
        if (intersection && intersection.startTimeUTC === now) {
          newReservation = new TimelineEntry();
          newReservation.offer = snapshot;
          newReservation.targetOrganizationUrl = listing.orgUrl;
          newReservation.startTimeUTC = intersection.startTimeUTC;
          newReservation.endTimeUTC = intersection.endTimeUTC;
          newReservation.isReservation = true;
          break;
        }
      }
    }

    // Now, convert all the listings to timeline entries.
    const timelineEntries = [];
    if (newReservation) {
      timelineEntries.push(newReservation);
    }
    for (const listing of listings) {
      let reshareChain = undefined;
      // Figure out whether a reshare chain is required. We don't want to
      // provide reshare chains that only have a single link with the ACCEPT
      // permission; that's equivalent to no reshare chain at all.
      // First, determine whether the listing specifies the reshare scope. If it
      // does, resharing is required.
      const listingHasReshareScope =
        listing.scopes && listing.scopes.indexOf('RESHARE') >= 0;
      // Next, determine if this offer came from another server. If it did, it
      // requires us to extend the reshare chain to give the next server
      // permission to accept it.
      const offerIsFromAnotherServer = offer.offeredBy !== this.hostOrgUrl;
      // If either of those conditions is true, extend the reshare chain.
      if (listingHasReshareScope || offerIsFromAnotherServer) {
        const scopes = listing.scopes || ['ACCEPT'];
        reshareChain = await this.signer.signChain(
          bestReshareChainRoot,
          listing.orgUrl,
          {
            scopes: scopes,
            initialEntitlement: offer.id,
          }
        );
      }
      // If there's a live reservation on the offer, trim all listings to
      // begin after the reservation expires. The subtract interval operation
      // can return multiple intervals, so we have to build a timeline entry
      // for each one.
      const listingIntervals = newReservation
        ? subtract(listing, newReservation)
        : [listing];
      for (const interval of listingIntervals) {
        const timelineEntry = new TimelineEntry();
        timelineEntry.offer = snapshot;
        timelineEntry.targetOrganizationUrl = listing.orgUrl;
        timelineEntry.startTimeUTC = interval.startTimeUTC;
        timelineEntry.endTimeUTC = interval.endTimeUTC;
        timelineEntry.reshareChain = reshareChain;
        timelineEntries.push(timelineEntry);
      }
    }
    return timelineEntries;
  }

  private async truncateLiveTimelineEntriesWithTransaction(
    entityManager: EntityManager,
    offerId: string,
    postingOrgUrl: string,
    now: number
  ): Promise<Array<TimelineEntry>> {
    const liveListingsQuery = entityManager
      .getRepository(TimelineEntry)
      .createQueryBuilder('timelineentries')
      .where('timelineentries.offer.offerId = :offerId')
      .andWhere('timelineentries.offer.postingOrgUrl = :postingOrgUrl')
      .andWhere('timelineentries.startTimeUTC <= :now')
      .andWhere('timelineentries.endTimeUTC > :now')
      .andWhere('timelineentries.isRejection = :isRejection')
      .setParameters({
        now: now,
        offerId: offerId,
        postingOrgUrl: postingOrgUrl,
        isRejection: false,
      });
    const liveListings = await liveListingsQuery.getMany();
    this.logger.debug('Truncating live listings', liveListings);
    const deletions = [];
    const updates = [];
    for (const entry of liveListings) {
      const newInterval = trim(entry, {
        endAt: now,
      });
      if (!newInterval) {
        deletions.push(entry.id);
      } else {
        updateInterval(entry, newInterval);
        updates.push(entry);
      }
    }
    if (updates.length) {
      this.logger.debug('updating timeline entries', updates);
      await entityManager.getRepository(TimelineEntry).save(updates);
    }
    if (deletions.length) {
      this.logger.debug('deleting timeline entries', deletions);
      await entityManager.getRepository(TimelineEntry).delete(deletions);
    }
    return liveListings;
  }

  private async getCurrentRejectionsWithTransaction(
    entityManager: EntityManager,
    offerId: string,
    postingOrgUrl: string,
    now: number
  ): Promise<Array<TimelineEntry>> {
    return await entityManager
      .getRepository(TimelineEntry)
      .createQueryBuilder('timelineentries')
      .where('timelineentries.offer.offerId = :offerId', {offerId: offerId})
      .andWhere('timelineentries.offer.postingOrgUrl = :postingOrgUrl', {
        postingOrgUrl: postingOrgUrl,
      })
      .andWhere('timelineentries.startTimeUTC <= :now', {now: now})
      .andWhere('timelineentries.endTimeUTC > :now', {now: now})
      .andWhere('timelineentries.isRejection = true')
      .getMany();
  }

  private async getCurrentReservationWithTransaction(
    entityManager: EntityManager,
    offerId: string,
    postingOrgUrl: string,
    now: number
  ): Promise<TimelineEntry | undefined> {
    return (
      (await entityManager
        .getRepository(TimelineEntry)
        .createQueryBuilder('timelineentries')
        .where('timelineentries.offer.offerId = :offerId', {offerId: offerId})
        .andWhere('timelineentries.offer.postingOrgUrl = :postingOrgUrl', {
          postingOrgUrl: postingOrgUrl,
        })
        .andWhere('timelineentries.startTimeUTC <= :now', {now: now})
        .andWhere('timelineentries.endTimeUTC > :now', {now: now})
        .andWhere('timelineentries.isReservation = true')
        .getOne()) || undefined
    );
  }

  private checkTimelineEntries(entries: TimelineEntry[]) {
    const entryMap = {} as Record<string, TimelineEntry[]>;
    let reservation = undefined;
    for (const entry of entries) {
      let entryList = entryMap[entry.targetOrganizationUrl];
      if (!entryList) {
        entryList = [];
        entryMap[entry.targetOrganizationUrl] = entryList;
      }
      entryList.push(entry);
      if (entry.isReservation) {
        if (reservation) {
          throw new StatusError(
            'Found two reservation entries for ' + entry.offer.offerId,
            'INTERNAL_CHECK_FAILED_SQL_DATABASE_MULTIPLE_RESERVATIONS',
            500
          );
        }
        reservation = entry;
      }
    }
    for (const orgUrl in entryMap) {
      const entries = entryMap[orgUrl];
      for (let i = 0; i < entries.length; i++) {
        for (let j = 0; j < entries.length; j++) {
          if (i === j) {
            continue;
          }
          const intersection = intersect(entries[i], entries[j]);
          if (intersection) {
            throw new StatusError(
              'Found intersecting timeline entries for ' +
                `${entries[i].offer.offerId} to org ${orgUrl}`,
              'INTERNAL_CHECK_FAILED_SQL_DATABASE_TIMELINE_OVERLAP',
              500
            );
          }
        }
        if (!reservation || entries[i] === reservation) {
          continue;
        }
        const intersection = intersect(entries[i], reservation);
        if (intersection) {
          throw new StatusError(
            'Found timeline entry overlapping reservation in offer ' +
              `${entries[i].offer.offerId} to org ${orgUrl}`,
            'INTERNAL_CHECK_FAILED_SQL_DATABASE_TIMELINE_OVERLAP',
            500
          );
        }
      }
    }
  }

  /**
   * Returns the index of the shortest, defined reshare chain that provides
   * RESHARE permissions.
   */
  private findBestReshareChainIndex(
    decodedChains: Array<DecodedReshareChain | undefined>
  ): number {
    let bestSoFarIndex = -1;
    let currentWinner: DecodedReshareChain | undefined = undefined;
    for (let i = 0; i < decodedChains.length; i++) {
      const candidate = decodedChains[i];
      if (!candidate) {
        continue;
      }
      if (
        candidate[candidate.length - 1].scopes.indexOf('RESHARE') >= 0 &&
        (!currentWinner || currentWinner.length > candidate.length)
      ) {
        bestSoFarIndex = i;
        currentWinner = candidate;
      }
    }
    return bestSoFarIndex;
  }

  /**
   * Returns the index of the first undefined reshare chain (which means the
   * local server can accept), or the shortest reshare chain that ends with an
   * ACCEPT permission.
   */
  private findBestLocalAcceptChainIndex(
    decodedChains: Array<DecodedReshareChain | undefined>
  ): number {
    let bestSoFarIndex = -1;
    let currentWinner: DecodedReshareChain | undefined = undefined;
    for (let i = 0; i < decodedChains.length; i++) {
      const candidate = decodedChains[i];
      if (!candidate) {
        return i;
      }
      const finalScopes = candidate[candidate.length - 1].scopes;
      const canAccept =
        finalScopes.length === 0 || finalScopes.indexOf('ACCEPT') >= 0;
      if (
        canAccept &&
        (!currentWinner || currentWinner.length > candidate.length)
      ) {
        bestSoFarIndex = i;
        currentWinner = candidate;
      }
    }
    return bestSoFarIndex;
  }

  async dump(...tables: Array<string>): Promise<void> {
    tables = tables.length
      ? tables
      : [
          'corpus',
          'corpusoffer',
          'snapshot',
          'rejection',
          'timelineentry',
          'historyviewer',
        ];

    for (const table of tables) {
      await this.dumpTable(table);
    }
  }

  async dumpTable(
    table: string,
    entityManager = this.db.manager
  ): Promise<void> {
    let repo;
    switch (table) {
      case 'corpus':
        repo = entityManager.getRepository(FeedCorpus);
        break;
      case 'corpusoffer':
        repo = entityManager.getRepository(FeedCorpusOffer);
        break;
      case 'snapshot':
        repo = entityManager.getRepository(OfferSnapshot);
        break;
      case 'timelineentry':
        repo = entityManager.getRepository(TimelineEntry);
        break;
      case 'historyviewer':
        repo = entityManager.getRepository(AcceptanceHistoryViewer);
        break;
      default:
        throw new Error('Unknown table name ' + table);
    }
    this.logger.log(
      table,
      ':\n',
      await repo.createQueryBuilder('x').select('*').getRawMany()
    );
  }

  async accept(
    offerId: string,
    orgUrl: string,
    ifNotNewerThanTimestampUTC?: number,
    decodedReshareChain?: DecodedReshareChain
  ): Promise<AcceptOfferResponse> {
    return this.runInTransaction(em =>
      this.acceptInTransaction(
        em,
        offerId,
        orgUrl,
        ifNotNewerThanTimestampUTC,
        decodedReshareChain
      )
    );
  }

  private async acceptInTransaction(
    entityManager: EntityManager,
    offerId: string,
    orgUrl: string,
    ifNotNewerThanTimestampUTC?: number,
    decodedReshareChain?: DecodedReshareChain
  ): Promise<AcceptOfferResponse> {
    const now = this.clock.now();
    const timelineEntry = await this.getOfferTimelineEntryForOrg(
      entityManager,
      orgUrl,
      // The posting org url has to be this server, since you can only accept
      // an offer from the server that originally shared it.
      this.hostOrgUrl,
      offerId,
      now
    );
    if (!timelineEntry) {
      throw new StatusError(
        `No offer with id ${offerId} is available to accept`,
        'ACCEPT_ERROR_NO_AVAILABLE_OFFER',
        400
      );
    }
    // NOTE: We don't need to check whether it's already been accepted. If the
    // offer has been accepted, it should be hidden from everyone.
    const offer = timelineEntry.offer.offer;
    const updateTime = timelineEntry.offer.lastUpdateUTC;
    if (
      ifNotNewerThanTimestampUTC !== undefined &&
      updateTime > ifNotNewerThanTimestampUTC
    ) {
      throw new StatusError(
        `Offer with id ${offerId} has been updated ` +
          `since ${ifNotNewerThanTimestampUTC}`,
        'ACCEPT_ERROR_OFFER_HAS_CHANGED',
        400,
        {
          currentOffer: offer,
        }
      );
    }
    const acceptance = new Acceptance();
    acceptance.acceptedAtUTC = now;
    acceptance.acceptedBy = orgUrl;
    acceptance.snapshot = timelineEntry.offer;
    acceptance.decodedReshareChain = decodedReshareChain;
    await entityManager.save(acceptance);
    // Collect and dedupe everyone that can view this acceptance history. That
    // includes the current server (since it created the offer), the accepting
    // org (because now it owns the offer), and everyone that reshared the
    // offer (since they helped complete the acceptance)
    const visibleToOrgs = new Set<string>();
    visibleToOrgs.add(this.hostOrgUrl);
    visibleToOrgs.add(orgUrl);
    if (decodedReshareChain) {
      for (const link of decodedReshareChain) {
        visibleToOrgs.add(link.sharingOrgUrl);
      }
    }
    const historyViewers = [];
    for (const visibleToOrg of visibleToOrgs) {
      const historyViewer = new AcceptanceHistoryViewer();
      historyViewer.acceptance = acceptance;
      historyViewer.visibleToOrgUrl = visibleToOrg;
      historyViewers.push(historyViewer);
    }
    await entityManager.save(historyViewers);

    await this.truncateLiveTimelineEntriesWithTransaction(
      entityManager,
      offerId,
      offer.offeredBy!,
      now
    );
    // TODO: Delete the timeline entries for this offer.
    await this.fireChange({
      type: 'ACCEPT',
      oldValue: offer,
      newValue: offer,
      timestampUTC: now,
    });
    return {
      offer: offer,
    };
  }

  async reject(
    rejectingOrgUrl: string,
    offerId: string,
    offeringOrgUrl?: string
  ): Promise<RejectOfferResponse> {
    return this.runInTransaction(em =>
      this.rejectInTransaction(em, rejectingOrgUrl, offerId, offeringOrgUrl)
    );
  }

  async rejectInTransaction(
    entityManager: EntityManager,
    rejectingOrgUrl: string,
    offerId: string,
    offeringOrgUrl?: string
  ): Promise<RejectOfferResponse> {
    const now = this.clock.now();
    const timelineEntry = await this.getOfferTimelineEntryForOrg(
      entityManager,
      rejectingOrgUrl,
      offeringOrgUrl ?? this.hostOrgUrl,
      offerId,
      now
    );
    if (!timelineEntry) {
      throw new StatusError(
        `No offer with id ${offerId} is available to reject`,
        'REJECT_ERROR_NO_AVAILABLE_OFFER',
        400
      );
    }
    // NOTE: We don't need to check whether it's already been accepted. If the
    // offer has been accepted, it should be hidden from everyone.
    const snapshot = timelineEntry.offer;
    const offer = snapshot.offer;
    const rejection = new TimelineEntry();
    rejection.offer = snapshot;
    rejection.targetOrganizationUrl = rejectingOrgUrl;
    rejection.startTimeUTC = now;
    rejection.endTimeUTC = offer.offerExpirationUTC;
    rejection.isRejection = true;
    await entityManager.getRepository(TimelineEntry).save(rejection);
    await this.updateListingsWithTransaction(
      entityManager,
      timelineEntry.offer,
      now
    );
    return {
      offer: offer,
    };
  }

  async reserve(
    offerId: string,
    requestedReservationSecs: number,
    orgUrl: string
  ): Promise<ReserveOfferResponse> {
    return this.runInTransaction(em =>
      this.reserveInTransaction(em, offerId, requestedReservationSecs, orgUrl)
    );
  }

  async reserveInTransaction(
    entityManager: EntityManager,
    offerId: string,
    requestedReservationSecs: number,
    orgUrl: string
  ): Promise<ReserveOfferResponse> {
    const now = this.clock.now();
    const timelineEntry = await this.getOfferTimelineEntryForOrg(
      entityManager,
      orgUrl,
      // The posting org url has to be this server, since you can only accept
      // an offer from the server that originally shared it.
      this.hostOrgUrl,
      offerId,
      now
    );
    if (!timelineEntry) {
      throw new StatusError(
        `No offer with id ${offerId} is available to reserve`,
        'RESERVE_ERROR_NO_AVAILABLE_OFFER',
        400
      );
    }
    // NOTE: We don't need to check whether it's already been accepted. If the
    // offer has been accepted, it should be hidden from everyone.
    const snapshot = timelineEntry.offer;
    const offer = snapshot.offer;
    const reservationLengthMillis = Math.min(
      timelineEntry.endTimeUTC - now,
      offer.maxReservationTimeSecs
        ? offer.maxReservationTimeSecs * 1000
        : Number.MAX_SAFE_INTEGER,
      requestedReservationSecs * 1000
    );
    const newReservation = new TimelineEntry();
    newReservation.offer = snapshot;
    newReservation.targetOrganizationUrl = orgUrl;
    newReservation.startTimeUTC = now;
    newReservation.endTimeUTC = now + reservationLengthMillis;
    newReservation.isReservation = true;
    await entityManager.getRepository(TimelineEntry).save(newReservation);
    await this.updateListingsWithTransaction(
      entityManager,
      timelineEntry.offer,
      now
    );
    return {
      reservationExpirationUTC: newReservation.endTimeUTC,
      offer: offer,
    };
  }

  async getHistory(
    orgUrl: string,
    payload: HistoryPayload
  ): Promise<HistoryResponse> {
    // NOTE: A transaction isn't necessary here - this is a single,
    // low-consequence read.
    const sinceTimestampUTC = payload.historySinceUTC ?? 0;
    const historyEntries = await this.db.manager
      .getRepository(AcceptanceHistoryViewer)
      .createQueryBuilder('historyviewer')
      .leftJoinAndSelect('historyviewer.acceptance', 'acceptance')
      .leftJoinAndSelect('acceptance.snapshot', 'snapshot')
      .where('historyviewer.visibleToOrgUrl = :orgUrl')
      .andWhere('acceptance.acceptedAtUTC >= :sinceTimestampUTC')
      .setParameters({
        orgUrl: orgUrl,
        sinceTimestampUTC: sinceTimestampUTC,
      })
      .getMany();
    return {
      offerHistories: historyEntries.map(entry => {
        return {
          offer: entry.acceptance.snapshot.offer,
          acceptingOrganization: entry.acceptance.acceptedBy,
          acceptedAtUTC: entry.acceptance.acceptedAtUTC,
          decodedReshareChain: entry.acceptance.decodedReshareChain,
        } as OfferHistory;
      }),
    };
  }

  private async fireChange(change: OfferChange): Promise<void> {
    // TODO: If the change is an "add", store the offeredBy URL in a list of
    // offering orgs we've seen. This list will be used to collect the full
    // offer contribution history of this server.
    await Promise.all(this.changeHandlers.map(handlerFn => handlerFn(change)));
  }

  registerChangeHandler(
    handlerFn: (change: OfferChange) => Promise<void>
  ): HandlerRegistration {
    this.changeHandlers.push(handlerFn);
    return new SqlOprDatabaseHandlerRegistration(
      handlerFn,
      this.changeHandlers
    );
  }
}

class SqlOprDatabaseHandlerRegistration implements HandlerRegistration {
  private changeHandlers: Array<(change: OfferChange) => Promise<void>>;
  private handler: (change: OfferChange) => Promise<void>;

  constructor(
    handler: (change: OfferChange) => Promise<void>,
    changeHandlers: Array<(change: OfferChange) => Promise<void>>
  ) {
    this.changeHandlers = changeHandlers;
    this.handler = handler;
  }

  remove(): void {
    const index = this.changeHandlers.indexOf(this.handler);
    this.changeHandlers.splice(index, 1);
  }
}
