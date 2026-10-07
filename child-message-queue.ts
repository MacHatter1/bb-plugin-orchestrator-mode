import type { BbPluginApi } from "@get-bb/plugin-sdk";

type Queue = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["queuedMessages"]["list"]>>;
type Entry = Queue[number];

export const CHILD_BATCH_WAIT_REASON = "Preparing queued updates from the same child for one delivery.";

/** Group the original durable rows; never copy, send or delete their contents. */
export function childMessageQueue(
  bb: BbPluginApi,
  enabled: (threadId: string) => Promise<boolean>,
) {
  let disposed = false;
  const jobs = new Map<string, Promise<void>>();
  const dirty = new Set<string>();

  function owned(entry: Entry): boolean {
    return entry.waitingOn?.kind === "plugin" && entry.waitingOn.pluginId === bb.pluginId;
  }

  function eligible(entry: Entry): boolean {
    return owned(entry) && entry.initiator === "agent" && entry.senderThreadId !== null &&
      entry.payload.kind === "inline" && entry.sendAt === null && entry.failureReason === null;
  }

  function compatible(first: Entry, entry: Entry): boolean {
    return first.senderThreadId === entry.senderThreadId && first.model === entry.model &&
      first.reasoningLevel === entry.reasoningLevel && first.permissionMode === entry.permissionMode &&
      first.serviceTier === entry.serviceTier;
  }

  async function batch(threadId: string, entries: Queue): Promise<Queue> {
    const first = entries[0];
    if (disposed || !first || !eligible(first)) return [];
    const window: Queue = [];
    for (const entry of entries) {
      if (!eligible(entry)) break;
      // Do not move a child's later update ahead of an earlier update that
      // requires a different execution, or cross another child's manual group.
      if (entry.senderThreadId === first.senderThreadId && !compatible(first, entry)) break;
      if (entry.senderThreadId !== first.senderThreadId && entry.groupWithNext) break;
      window.push(entry);
    }
    const parents = new Map(await Promise.all(
      [...new Set(window.map((entry) => entry.senderThreadId!))].map(async (sender) =>
        [sender, (await bb.sdk.threads.get({ threadId: sender })).parentThreadId] as const,
      ),
    ));
    if (disposed) return [];
    const selected: Queue = [];
    for (const entry of window) {
      if (parents.get(entry.senderThreadId!) !== threadId) break;
      if (compatible(first, entry)) selected.push(entry);
    }
    // BB's boundary operation clears all trailing group edges. Preserve any
    // existing group outside this batch instead of silently splitting it.
    const ids = new Set(selected.map((entry) => entry.id));
    if (entries.some((entry, index) => entry.groupWithNext &&
      (!ids.has(entry.id) || !ids.has(entries[index + 1]?.id ?? "")))) return [];
    return selected.length > 1 ? selected : [];
  }

  async function group(threadId: string): Promise<boolean> {
    let changed = false;
    attempts: for (let attempt = 0; attempt < 3 && !disposed; attempt++) {
      try {
        if (!await enabled(threadId) || disposed) return changed;
        let entries = await bb.sdk.threads.queuedMessages.list({ threadId });
        const selected = await batch(threadId, entries);
        if (selected.length < 2 || disposed) return changed;
        const firstId = selected[0]!.id;
        for (let index = 1; index < selected.length; index++) {
          if (index > 1) {
            const current = await batch(threadId, entries);
            if (current[0]?.id !== firstId || !current.some((entry) => entry.id === selected[index]!.id)) {
              continue attempts;
            }
          }
          if (entries[index]?.id === selected[index]!.id) continue;
          if (!await enabled(threadId) || disposed) return changed;
          entries = await bb.sdk.threads.queuedMessages.reorder({
            threadId,
            queuedMessageId: selected[index]!.id,
            previousQueuedMessageId: selected[index - 1]!.id,
            nextQueuedMessageId: entries[index]?.id ?? null,
          });
          changed = true;
        }
        // Revalidate the returned snapshot after reorders. Native CAS rejects
        // a prefix that was claimed, deleted or reordered concurrently.
        const current = await batch(threadId, entries);
        const prefix = entries.slice(0, current.length);
        if (current.length < 2 || current[0]?.id !== firstId ||
          prefix.some((entry, index) => entry.id !== current[index]?.id)) continue;
        if (prefix.every((entry, index) => entry.groupWithNext === (index < prefix.length - 1))) {
          return changed;
        }
        if (!await enabled(threadId) || disposed) return changed;
        await bb.sdk.threads.queuedMessages.setGroupBoundary({
          threadId,
          expectedGroupedPrefixQueuedMessageIds: prefix.map((entry) => entry.id),
          groupBoundaryQueuedMessageId: prefix[prefix.length - 1]!.id,
        });
        return true;
      } catch (cause) {
        if (attempt === 2 && !disposed) {
          bb.log.warn(`child message grouping failed for ${threadId}: ${String(cause)}`);
        }
      }
    }
    return changed;
  }

  function prepare(threadId: string): Promise<void> {
    if (disposed) return Promise.resolve();
    dirty.add(threadId);
    const existing = jobs.get(threadId);
    if (existing) return existing;
    const job = (async () => {
      let changed = false;
      do {
        dirty.delete(threadId);
        changed = await group(threadId) || changed;
      } while (!disposed && dirty.has(threadId));
      if (changed && !disposed) bb.experimental_hooks.recheck("message.dispatch");
    })().finally(() => jobs.delete(threadId));
    jobs.set(threadId, job);
    return job;
  }

  return {
    owned,
    prepare,
    async defer(threadId: string, claimed: Queue): Promise<boolean> {
      if (disposed || claimed.length === 0 || claimed.some((entry) => !eligible(entry))) return false;
      // A single preparatory retry closes the claim-vs-group race. If the SDK
      // stays unavailable, let BB deliver the original rows rather than wedge
      // the queue indefinitely. Active-turn holds still apply independently.
      if (claimed.some((entry) => entry.waitingOn?.kind === "plugin" &&
        entry.waitingOn.reason.includes(CHILD_BATCH_WAIT_REASON))) return false;
      const pending = await bb.sdk.threads.queuedMessages.list({ threadId });
      const ids = new Set(claimed.map((entry) => entry.id));
      const selected = await batch(threadId, [...claimed, ...pending.filter((entry) => !ids.has(entry.id))]);
      return selected.length > claimed.length && claimed.every((entry, index) => selected[index]?.id === entry.id);
    },
    dispose() { disposed = true; dirty.clear(); },
  };
}
