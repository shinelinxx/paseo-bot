import assert from "node:assert/strict";
import test from "node:test";
import {
  computeHiddenPinnedProjects,
  encodeSidebarProjectGroupKey,
  shouldHideSidebarProjectGroup,
} from "../client/sidebar-filter.ts";

test("computeHiddenPinnedProjects hides only projects with pinned workspaces and zero unpinned workspaces", () => {
  const hostId = "srv_cawFlHelfpWp";
  const kbKey = encodeSidebarProjectGroupKey(
    hostId,
    "prj_kb",
    "/Users/shinelin/Documents/KnowledgeBase",
  );
  const mpKey = encodeSidebarProjectGroupKey(
    hostId,
    "prj_mp",
    "/Users/shinelin/Documents/MoneyPrinter",
  );
  const genKey = encodeSidebarProjectGroupKey(
    hostId,
    "prj_gen",
    "/Users/shinelin/Documents/General",
  );
  const ibkrKey = encodeSidebarProjectGroupKey(
    hostId,
    "prj_ibkr",
    "/Users/shinelin/Documents/ibkr-trader",
  );
  const botKey = encodeSidebarProjectGroupKey(
    hostId,
    "prj_bot",
    "/Users/shinelin/Documents/paseo/paseo-bot",
  );

  const spec = computeHiddenPinnedProjects({
    projectGroups: [
      { key: kbKey, title: "KnowledgeBase" },
      { key: mpKey, title: "MoneyPrinter" },
      { key: genKey, title: "General" },
      { key: ibkrKey, title: "ibkr-trader" },
      { key: botKey, title: "paseo-bot" },
    ],
    pinnedWorkspaceGroups: [
      { key: kbKey, title: "KnowledgeBase" },
      { key: mpKey, title: "MoneyPrinter" },
      { key: genKey, title: "General" },
    ],
    unpinnedWorkspaceGroups: [
      { key: genKey, title: "General" },
      { key: ibkrKey, title: "ibkr-trader" },
    ],
  });

  // MoneyPrinter & KnowledgeBase are pinned with 0 unpinned workspaces -> hidden
  assert.equal(spec.safeDisplayNames.has("MoneyPrinter"), true);
  assert.equal(spec.safeDisplayNames.has("KnowledgeBase"), true);
  assert.equal(
    spec.viewKeys.has(`host:${hostId}:/Users/shinelin/Documents/MoneyPrinter`),
    true,
  );
  assert.equal(spec.viewKeys.has(JSON.stringify([hostId, "prj_mp"])), true);

  // General still has an unpinned workspace -> stays visible
  assert.equal(spec.safeDisplayNames.has("General"), false);
  assert.equal(spec.viewKeys.has(JSON.stringify([hostId, "prj_gen"])), false);

  // ibkr-trader is unpinned, paseo-bot has 0 pinned -> stay visible
  assert.equal(spec.safeDisplayNames.has("ibkr-trader"), false);
  assert.equal(spec.safeDisplayNames.has("paseo-bot"), false);

  // Git project matched via safeDisplayNames (viewKey is remote:...)
  assert.equal(
    shouldHideSidebarProjectGroup({
      viewKey: "remote:github.com/shinelinxx/knowledgebase",
      groupLabel: "KnowledgeBase",
      hasVisibleWorkspaceRow: false,
      spec,
    }),
    true,
  );

  // Safety DOM guard: never hide if a visible unpinned workspace row is present
  assert.equal(
    shouldHideSidebarProjectGroup({
      viewKey: `host:${hostId}:/Users/shinelin/Documents/MoneyPrinter`,
      groupLabel: "MoneyPrinter",
      hasVisibleWorkspaceRow: true,
      spec,
    }),
    false,
  );
});

test("computeHiddenPinnedProjects avoids hiding by displayName when two projects share a name and one is visible", () => {
  const hiddenKey = encodeSidebarProjectGroupKey("srv_1", "prj_a", "/tmp/work/app");
  const visibleKey = encodeSidebarProjectGroupKey("srv_2", "prj_b", "/tmp/other/app");

  const spec = computeHiddenPinnedProjects({
    projectGroups: [
      { key: hiddenKey, title: "app" },
      { key: visibleKey, title: "app" },
    ],
    pinnedWorkspaceGroups: [{ key: hiddenKey, title: "app" }],
    unpinnedWorkspaceGroups: [{ key: visibleKey, title: "app" }],
  });

  assert.equal(spec.safeDisplayNames.has("app"), false);
  assert.equal(
    shouldHideSidebarProjectGroup({
      viewKey: "host:srv_1:/tmp/work/app",
      groupLabel: "app",
      hasVisibleWorkspaceRow: false,
      spec,
    }),
    true,
  );
  assert.equal(
    shouldHideSidebarProjectGroup({
      viewKey: "host:srv_2:/tmp/other/app",
      groupLabel: "app",
      hasVisibleWorkspaceRow: false,
      spec,
    }),
    false,
  );
});
