import type { EventFactory } from '../events/factory';
import type { TransportLayer } from '../transport';
import { defaultCaptureOptions, type BaseCollector, type CaptureOptions } from './base';
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

  constructor(
    factory: EventFactory,
    transport: TransportLayer,
    options: CaptureOptions = defaultCaptureOptions(),
  ) {
    this.collectors = [
      new FileReadingCollector(factory, transport, options),
      new NavigationCollector(factory, transport, options),
      new EditPatternCollector(factory, transport, options),
      new FocusCollector(factory, transport, options),
      new DiagnosticCollector(factory, transport, options),
      new TerminalCollector(factory, transport, options),
      new FileLifecycleCollector(factory, transport, options),
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
