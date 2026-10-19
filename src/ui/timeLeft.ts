import * as vscode from 'vscode';

/** Minutes-left marks that interrupt the candidate. 0 is "time's up". */
const WARN_AT_MIN = [10, 5, 1, 0];

/** `42:13`, or `1:02:07` past an hour. Never negative. */
export function timeLeftText(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * The marks crossed between two ticks, as minutes left. Comparing against the
 * previous tick rather than "is it exactly 5:00" is what makes a warning fire
 * once even when a tick is late, and never for a mark already past when the
 * window was reloaded.
 */
export function crossed(prevMs: number, nowMs: number): number[] {
  return WARN_AT_MIN.filter((min) => prevMs > min * 60_000 && nowMs <= min * 60_000);
}

/**
 * The assessment clock, in the status bar.
 *
 * At zero the box is paused and the proxy closes the editor's socket, which
 * code-server can only show as "Reconnecting". The modal is the one chance to
 * say what actually happened before that.
 */
export class TimeLeft implements vscode.Disposable {
  private item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  private interval: ReturnType<typeof setInterval> | undefined;
  private deadlineAt: number | undefined;
  private last: number | undefined;

  /** Point the clock at a deadline (epoch ms), or hide it. Idempotent. */
  set(deadlineAt: number | undefined): void {
    if (deadlineAt === this.deadlineAt) return;
    this.deadlineAt = deadlineAt;
    this.last = undefined;
    clearInterval(this.interval);
    this.interval = undefined;
    if (deadlineAt === undefined) {
      this.item.hide();
      return;
    }
    this.tick();
    if (this.deadlineAt !== undefined && this.deadlineAt > Date.now())
      this.interval = setInterval(() => this.tick(), 1000);
  }

  private tick(): void {
    const left = this.deadlineAt! - Date.now();
    const marks = this.last === undefined ? [] : crossed(this.last, left);
    this.last = left;

    if (left <= 0) {
      clearInterval(this.interval);
      this.interval = undefined;
      this.item.text = "$(clock) Time's up";
      this.item.tooltip = 'Your work is being submitted automatically.';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else {
      this.item.text = `$(clock) ${timeLeftText(left)} left`;
      this.item.tooltip = 'Time left in this assessment. Your work is submitted automatically at zero.';
      this.item.backgroundColor =
        left <= 5 * 60_000 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    }
    this.item.show();

    const min = marks[marks.length - 1];
    if (min === 0) {
      void vscode.window.showWarningMessage(
        "Time's up. Your work is being submitted automatically, and this editor will disconnect in a moment. You can close this tab.",
        { modal: true },
      );
    } else if (min !== undefined) {
      void vscode.window.showWarningMessage(
        `${min} minute${min === 1 ? '' : 's'} left. Your work is submitted automatically when time runs out.`,
      );
    }
  }

  dispose(): void {
    clearInterval(this.interval);
    this.item.dispose();
  }
}
