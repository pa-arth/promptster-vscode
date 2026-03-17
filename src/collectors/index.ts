import type { EventFactory } from '../events/factory';
import type { TransportLayer } from '../transport';
import type { BaseCollector } from './base';
import { FileReadingCollector } from './fileReading';
import { NavigationCollector } from './navigation';
import { EditPatternCollector } from './editPattern';
import { FocusCollector } from './focus';
import { DiagnosticCollector } from './diagnostic';
import { TerminalCollector } from './terminal';
import { FileLifecycleCollector } from './fileLifecycle';
import { log } from '../utils/logger';

export class CollectorRegistry {
  private collectors: BaseCollector[] = [];

  constructor(factory: EventFactory, transport: TransportLayer) {
    this.collectors = [
      new FileReadingCollector(factory, transport),
      new NavigationCollector(factory, transport),
      new EditPatternCollector(factory, transport),
      new FocusCollector(factory, transport),
      new DiagnosticCollector(factory, transport),
      new TerminalCollector(factory, transport),
      new FileLifecycleCollector(factory, transport),
    ];
  }

  activateAll(): void {
    for (const c of this.collectors) {
      c.activate();
    }
    log(`${this.collectors.length} collectors activated`);
  }

  disposeAll(): void {
    for (const c of this.collectors) {
      c.dispose();
    }
    this.collectors = [];
    log('All collectors disposed');
  }
}
