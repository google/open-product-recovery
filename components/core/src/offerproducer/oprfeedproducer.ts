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
  ListOffersPayload,
  ListOffersResponse,
  Offer,
  OfferPatch,
} from 'opr-models';
import {OfferProducer, OfferSetUpdate} from './offerproducer';
import {log, Logger} from '../util/loglevel';
import {OprNetworkClient} from '../net/oprnetworkclient';
import {Clock} from '../util/clock';
import {DefaultClock} from '../util/defaultclock';
import {StatusError} from '../util/statuserror';

export class OprFeedProducer implements OfferProducer {
  readonly type = 'offerProducer';

  private client: OprNetworkClient;
  private organizationUrl: string;
  private clock: Clock;
  private pollFrequencyMillis: number;
  private logger: Logger;
  readonly id: string;

  constructor(
    client: OprNetworkClient,
    organizationUrl: string,
    pollFrequencyMillis = 10 * 60 * 1000 /* 10 minutes */,
    clock = new DefaultClock(),
    logger = log.getLogger(`feed:${organizationUrl}`)
  ) {
    this.client = client;
    this.organizationUrl = organizationUrl;
    this.id = 'feed:' + organizationUrl;
    this.clock = clock;
    this.pollFrequencyMillis = pollFrequencyMillis;
    this.logger = logger;
  }

  async produceOffers(request: ListOffersPayload): Promise<OfferSetUpdate> {
    const result = await this.client.list(this.organizationUrl, request);
    let offers: AsyncIterable<Offer> | undefined;
    let patchOps: AsyncIterable<OfferPatch> | undefined;
    if (result.offers) {
      offers = this.toOfferIterable(request, result);
    } else {
      patchOps = this.toPatchOpsIterable(request, result);
    }

    const now = this.clock.now();
    const updateResult = {
      offers: offers,
      sourceOrgUrl: this.organizationUrl,
      delta: patchOps,
      diffStartTimeUTC: request.diffStartTimestampUTC,
      updateCurrentAsOfTimestampUTC: result.resultsTimestampUTC,
      earliestNextRequestUTC: now + this.pollFrequencyMillis,
    };
    this.logger.info('Returning update result', updateResult);
    return updateResult;
  }

  private async *toOfferIterable(
    request: ListOffersPayload,
    listOffersResponse: ListOffersResponse
  ): AsyncIterable<Offer> {
    let hasNextPage;
    do {
      if (!listOffersResponse.offers) {
        throw new StatusError(
          'Illegal producer response, ' +
            'paged response was answered in multiple formats',
          'PRODUCER_ILLEGAL_RESPONSE_PAGES_INCONSISTENT',
          500
        );
      }
      for (const offer of listOffersResponse.offers) {
        yield offer;
      }
      hasNextPage = listOffersResponse.nextPageToken !== undefined;
      if (hasNextPage) {
        listOffersResponse = await this.client.list(this.organizationUrl, {
          ...request,
          pageToken: listOffersResponse.nextPageToken,
        });
      }
    } while (hasNextPage);
  }

  private async *toPatchOpsIterable(
    request: ListOffersPayload,
    listOffersResponse: ListOffersResponse
  ): AsyncIterable<OfferPatch> {
    let hasNextPage;
    do {
      if (!listOffersResponse.diff) {
        throw new StatusError(
          'Illegal producer response, ' +
            'paged response was answered in multiple formats',
          'PRODUCER_ILLEGAL_RESPONSE_PAGES_INCONSISTENT',
          500
        );
      }
      for (const patchOp of listOffersResponse.diff) {
        yield patchOp;
      }
      hasNextPage = listOffersResponse.nextPageToken !== undefined;
      if (hasNextPage) {
        listOffersResponse = await this.client.list(this.organizationUrl, {
          ...request,
          pageToken: listOffersResponse.nextPageToken,
        });
      }
    } while (hasNextPage);
  }
}
