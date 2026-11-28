export interface SidebarGroupTuple {
  readonly key: string;
  readonly title: string | null;
}

export interface HiddenPinnedProjectsSpec {
  /** Exact Paseo sidebar viewKeys (e.g. `host:<hostId>:<rootPath>` or `["<hostId>","<projectId>"]`). */
  readonly viewKeys: ReadonlySet<string>;
  /** Exact project displayNames (`aria-label` on `[role="group"]`) where every project with that name is pinned-and-empty. */
  readonly safeDisplayNames: ReadonlySet<string>;
}

const KEY_SEP = "\0";

export function encodeSidebarProjectGroupKey(
  hostId: string,
  projectId: string,
  rootPath: string,
): string {
  return `${hostId}${KEY_SEP}${projectId}${KEY_SEP}${rootPath}`;
}

function decodeSidebarProjectGroupKey(key: string): {
  hostId: string;
  projectId: string;
  rootPath: string;
} {
  const first = key.indexOf(KEY_SEP);
  if (first === -1) {
    return { hostId: "", projectId: key, rootPath: "" };
  }
  const second = key.indexOf(KEY_SEP, first + 1);
  if (second === -1) {
    return {
      hostId: key.slice(0, first),
      projectId: key.slice(first + 1),
      rootPath: "",
    };
  }
  return {
    hostId: key.slice(0, first),
    projectId: key.slice(first + 1, second),
    rootPath: key.slice(second + 1),
  };
}

interface ProjectAggregate {
  hostId: string;
  projectId: string;
  rootPath: string;
  displayName: string;
  hasPinned: boolean;
  hasUnpinned: boolean;
}

/**
 * Compute which bottom-section sidebar project folders are already represented in
 * the top Pinned section and have zero unpinned active workspaces remaining.
 */
export function computeHiddenPinnedProjects(input: {
  readonly pinnedWorkspaceGroups: readonly SidebarGroupTuple[];
  readonly unpinnedWorkspaceGroups: readonly SidebarGroupTuple[];
  readonly projectGroups: readonly SidebarGroupTuple[];
}): HiddenPinnedProjectsSpec {
  const byProject = new Map<string, ProjectAggregate>();

  const ensure = (group: SidebarGroupTuple, authoritativeTitle: boolean): ProjectAggregate => {
    const { hostId, projectId, rootPath } = decodeSidebarProjectGroupKey(group.key);
    const idKey = `${hostId}${KEY_SEP}${projectId}`;
    const trimmedTitle = group.title?.trim() ?? "";
    const existing = byProject.get(idKey);
    if (existing) {
      if (rootPath && !existing.rootPath) existing.rootPath = rootPath;
      if (trimmedTitle && (authoritativeTitle || !existing.displayName)) {
        existing.displayName = trimmedTitle;
      }
      return existing;
    }
    const created: ProjectAggregate = {
      hostId,
      projectId,
      rootPath,
      displayName: trimmedTitle,
      hasPinned: false,
      hasUnpinned: false,
    };
    byProject.set(idKey, created);
    return created;
  };

  for (const g of input.projectGroups) {
    ensure(g, true);
  }
  for (const g of input.pinnedWorkspaceGroups) {
    ensure(g, false).hasPinned = true;
  }
  for (const g of input.unpinnedWorkspaceGroups) {
    ensure(g, false).hasUnpinned = true;
  }

  const viewKeys = new Set<string>();
  const hiddenNames = new Set<string>();
  const visibleNames = new Set<string>();

  for (const agg of byProject.values()) {
    const isHidden = agg.hasPinned && !agg.hasUnpinned;
    if (isHidden) {
      if (agg.hostId && agg.projectId) {
        viewKeys.add(JSON.stringify([agg.hostId, agg.projectId]));
      }
      if (agg.hostId && agg.rootPath) {
        viewKeys.add(`host:${agg.hostId}:${agg.rootPath}`);
      }
      if (agg.displayName) {
        hiddenNames.add(agg.displayName);
      }
    } else if (agg.displayName) {
      visibleNames.add(agg.displayName);
    }
  }

  const safeDisplayNames = new Set<string>();
  for (const name of hiddenNames) {
    if (!visibleNames.has(name)) {
      safeDisplayNames.add(name);
    }
  }

  return { viewKeys, safeDisplayNames };
}

export function shouldHideSidebarProjectGroup(input: {
  readonly viewKey: string;
  readonly groupLabel: string;
  readonly hasVisibleWorkspaceRow: boolean;
  readonly spec: HiddenPinnedProjectsSpec;
}): boolean {
  if (input.hasVisibleWorkspaceRow) return false;
  if (input.viewKey && input.spec.viewKeys.has(input.viewKey)) return true;
  const label = input.groupLabel.trim();
  if (label && input.spec.safeDisplayNames.has(label)) return true;
  return false;
}
