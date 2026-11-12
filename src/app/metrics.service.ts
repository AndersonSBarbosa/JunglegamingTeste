import { Injectable } from '@nestjs/common';

@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();
  private readonly observations = new Map<string, { count: number; sum: number }>();
  private readonly gauges = new Map<string, number>();

  increment(name: string, labels: Record<string, string> = {}): void {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  observe(name: string, value: number): void {
    const current = this.observations.get(name) ?? { count: 0, sum: 0 };
    current.count += 1;
    current.sum += value;
    this.observations.set(name, current);
  }

  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  render(): string {
    const lines: string[] = [];
    for (const [key, value] of this.counters) lines.push(`${key} ${value}`);
    for (const [name, value] of this.observations) {
      lines.push(`${name}_count ${value.count}`, `${name}_sum ${value.sum}`);
    }
    for (const [name, value] of this.gauges) lines.push(`${name} ${value}`);
    return `${lines.join('\n')}\n`;
  }

  private key(name: string, labels: Record<string, string>): string {
    const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    if (!entries.length) return name;
    const formatted = entries.map(([key, value]) => `${key}="${value}"`).join(',');
    return `${name}{${formatted}}`;
  }
}
