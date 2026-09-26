import { createMasterService } from './master-factory.ts';

// "Service" is the domain entity (what the company sells), not a code-level service.
const services = createMasterService('service', 'Service');

export const listServices = services.list;
export const getService = services.get;
export const createService = services.create;
export const updateService = services.update;
export const softDeleteService = services.softDelete;
export const restoreService = services.restore;
export const listServiceOptions = services.options;
