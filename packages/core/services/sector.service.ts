import { createMasterService } from './master-factory.ts';

const sectors = createMasterService('sector', 'Sector');

export const listSectors = sectors.list;
export const getSector = sectors.get;
export const createSector = sectors.create;
export const updateSector = sectors.update;
export const softDeleteSector = sectors.softDelete;
export const restoreSector = sectors.restore;
export const listSectorOptions = sectors.options;
