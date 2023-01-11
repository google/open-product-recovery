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

import {OfferListingPolicy} from '../offerlistingpolicy';
import {Offer} from 'opr-models';
import {Listing, ListingTarget} from '../../model/listing';

/**
 * A generic listing policy that determines listings from a series of nested
 * collections based on provided settings.
 *
 * This policy is useful for cases like "show to A and B for 10 minutes, then
 * show to C and D for 10 minutes." It also allows for multiple cases to exist
 * at the same level of the hierarchy. This enables cases like "show to A for 10
 * minutes and B for 20 minutes; after A, show to C for 10 minutes."
 *
 * Later, this will support generic offer filters at any level in the hierarchy.
 */
export class HierarchicalListingPolicy implements OfferListingPolicy {
  readonly type = 'listingPolicy';

  private listingHierarchies: Array<ListingHierarchy>;

  constructor(listingHierarchies: Array<ListingHierarchy>) {
    this.listingHierarchies = listingHierarchies;
  }

  private async buildListings(
    offer: Offer,
    listingHierarchies: Array<ListingHierarchy>,
    baseListings: Array<Listing> = [],
    firstListingTimeUTC: number,
    currentTimeUTC: number,
    rejections: Set<string>,
    sharedBy: Set<string>
  ): Promise<Array<Listing>> {
    let baseTime: number;
    for (const hierarchy of listingHierarchies) {
      baseTime = firstListingTimeUTC;
      const viableOrgs = hierarchy.listedOrgs.filter(
        org => !rejections.has(org.orgUrl) && !sharedBy.has(org.orgUrl)
      );
      if (viableOrgs) {
        for (const listing of viableOrgs) {
          baseListings.push({
            orgUrl: listing.orgUrl,
            startTimeUTC: baseTime,
            endTimeUTC: baseTime + hierarchy.totalTime,
            scopes: listing.scopes,
          });
        }
        baseTime += hierarchy.exclusiveTime;
      }
      if (hierarchy.childHierarchies) {
        baseListings.concat(
          await this.buildListings(
            offer,
            hierarchy.childHierarchies,
            baseListings,
            baseTime,
            currentTimeUTC,
            rejections,
            sharedBy
          )
        );
      }
    }
    return baseListings;
  }

  async getListings(
    offer: Offer,
    firstListingTimeUTC: number,
    currentTimeUTC: number,
    rejections: Set<string>,
    sharedBy: Set<string>
  ): Promise<Array<Listing>> {
    return this.buildListings(
      offer,
      this.listingHierarchies,
      [],
      firstListingTimeUTC,
      currentTimeUTC,
      rejections,
      sharedBy
    );
  }
}

export interface ListingHierarchy {
  // todo (ryckmanat): add filtering option here once we have a general method
  exclusiveTime: number;
  totalTime: number;
  listedOrgs: Array<ListingTarget>;
  childHierarchies?: Array<ListingHierarchy>;
}
