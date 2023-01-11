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
  DefaultClock,
  iterableToAsync,
  OfferProducer,
  OfferSetUpdate,
} from 'opr-core';
import {GoogleSheetsClient} from '../googlesheets/googlesheetsclient';
import {SimpleSheetFormat} from '../googlesheets/simplesheetformat';
import {GoogleSheetsFormat} from '../googlesheets/googlesheetsformat';

/** An OfferProducer that reads from Google Sheets */
export class GoogleSheetsOfferProducer implements OfferProducer {
  readonly type = 'offerProducer';

  readonly id: string;
  readonly client: GoogleSheetsClient;
  private clock: Clock;
  readonly sourceOrgUrl: string;
  private sheetFormat: GoogleSheetsFormat;

  constructor(options: GoogleSheetsOfferProducerOptions) {
    this.id = 'Sheets reader for ' + options.client.sheetId;
    this.client = options.client;
    this.clock = options.clock ?? new DefaultClock();
    this.sourceOrgUrl = options.sourceOrgUrl;
    this.sheetFormat = options.sheetFormat ?? new SimpleSheetFormat();
  }

  async produceOffers(/* ignoring parameters */): Promise<OfferSetUpdate> {
    const now = this.clock.now();
    const offers = await this.sheetFormat.getOffers(this.client);
    return {
      earliestNextRequestUTC: now,
      updateCurrentAsOfTimestampUTC: now,
      sourceOrgUrl: this.sourceOrgUrl,
      offers: iterableToAsync(offers),
    } as OfferSetUpdate;
  }
}

/** Options for GoogleSheetsOfferProducer */
export interface GoogleSheetsOfferProducerOptions {
  client: GoogleSheetsClient;
  clock?: Clock;
  sourceOrgUrl: string;
  sheetFormat?: GoogleSheetsFormat;
}
