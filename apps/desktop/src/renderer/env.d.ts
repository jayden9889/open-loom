import type { OpenLoomAPI, OpenLoomInternal } from '@shared/types';

declare global {
  interface Window {
    openloom: OpenLoomAPI;
    openloomInternal: OpenLoomInternal;
  }
}

export {};
