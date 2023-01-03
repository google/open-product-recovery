import { CustomRequestHandler } from "../customrequesthandler";
import { IntegrationApi, OfferChange } from "../../coreapi";
import { OprServer } from "../../../build/server/oprserver";


export const ingestEndpoint = (api: IntegrationApi, s: OprServer): any => { 
    return {
        method: ['GET', 'POST'],
        handle: async () => {
          const changes = [] as Array<OfferChange>;
          const changeHandler = api.registerChangeHandler(async change => {
            changes.push(change);
          });
          await s.ingest();
          changeHandler.remove();
          return changes;
        },
      }as CustomRequestHandler
    }
  