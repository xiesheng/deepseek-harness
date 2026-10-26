import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

// Compile-time half of a service and its events: declaration merging.
declare module '@deepseek-ai/cordis' {
  interface Context {
    counter: CounterService
  }
  interface Events {
    'counter/changed'(name: string, value: number): void
    'counter/validate'(name: string, next: () => string): string
  }
}

export interface Config {
  step: number
}

export const Config: Schema<Config> = Schema.object({
  step: Schema.natural().min(1).default(1),
})

export class CounterService extends Service {
  private counts = new Map<string, number>()

  constructor(ctx: Context, public config: Config) {
    // Runtime half: claims `ctx.counter` as an effect of this plugin.
    super(ctx, 'counter')
  }

  bump(name: string) {
    // Waterfall: listeners may rewrite the name or veto by not calling next().
    const accepted = this.ctx.waterfall('counter/validate', name, () => name)
    const value = (this.counts.get(accepted) ?? 0) + this.config.step
    this.counts.set(accepted, value)
    this.ctx.emit('counter/changed', accepted, value)
    return { name: accepted, value }
  }
}

export const name = 'counter'

export function apply(ctx: Context, config: Config) {
  ctx.plugin(CounterService, config)
}
