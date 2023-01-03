import { CustomRequestHandler } from "../customrequesthandler";
import {SqlOprPersistentStorage} from "../../../../../integrations/sql-database/build/index"

export const synchronizeEndpoint = (storageDriver: SqlOprPersistentStorage) :any => {

    return {
      method: ['POST', 'GET'],
    handle: async () => {
      await storageDriver.synchronize(true);
      return 'ok - db initialized';
    },
  } as CustomRequestHandler
    }
    