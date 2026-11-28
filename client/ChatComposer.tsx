import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import {
  MAX_ATTACHED_IMAGES,
  sendChatMessageRpc,
  tidySessionsRpc,
  type CatalogProvider,
} from "../shared/contracts";
import { resolveModelLabel, type TranslateFn } from "./ConsoleModals";
import { isChatEnterSubmitKey } from "./helpers";
import {
  appendWishDraftImages,
  beginPendingChatSend,
  clearWishDraftImages,
  confirmOptimisticChatMessage,
  optimisticAddChatMessage,
  removeWishDraftImage,
  rollbackOptimisticChatMessage,
  setDeepThinkEnabled,
  setSelectedConsoleProvider,
  setWishDraft,
  setWishDraftImages,
  useBotSelector,
  useDeepThinkEnabled,
  useSelectedConsoleProvider,
  useWishDraft,
  useWishDraftImages,
} from "./store";
import {
  isWebImageInputSupported,
  mountWebImagePasteTarget,
  pickWebImages,
  type ImageInputErrorReason,
  type PastedImageItem,
} from "./web";

type PluginTheme = PluginScreenProps["theme"];

const styles = StyleSheet.create({
  outerWrap: {
    flexShrink: 0,
    width: "100%",
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: Platform.OS === "ios" ? 10 : 12,
    alignItems: "center",
    zIndex: 20,
  },
  maxContainer: {
    position: "relative",
    width: "100%",
    maxWidth: 680,
    gap: 8,
  },
  menuBackdrop: {
    position: "absolute",
    top: -2000,
    left: -2000,
    right: -2000,
    bottom: -2000,
  },
  plusPopover: {
    position: "absolute",
    bottom: "100%",
    left: 0,
    marginBottom: 8,
    width: 268,
    zIndex: 30,
    borderRadius: 18,
    borderWidth: 1,
    padding: 6,
    gap: 2,
    shadowColor: "#000",
    shadowOpacity: 0.14,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingHorizontal: 11,
    paddingVertical: 9,
    borderRadius: 12,
  },
  menuItemLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    flex: 1,
  },
  menuItemTitle: {
    fontSize: 13,
    fontWeight: "600",
  },
  menuItemSub: {
    fontSize: 11,
  },
  menuDivider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 3,
    marginHorizontal: 8,
  },
  modePillsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 6,
  },
  modePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  modePillText: {
    fontSize: 11.5,
    fontWeight: "600",
  },
  capsuleShell: {
    borderRadius: 26,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 6,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  imageStripRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 6,
    paddingTop: 4,
  },
  thumbWrap: {
    position: "relative",
    width: 52,
    height: 52,
  },
  thumbImg: {
    width: 52,
    height: 52,
    borderRadius: 10,
    borderWidth: 1,
  },
  thumbRemoveBtn: {
    position: "absolute",
    top: -5,
    right: -5,
    width: 18,
    height: 18,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  dropBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  dropBannerText: {
    fontSize: 12,
    fontWeight: "600",
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
  },
  circleIconBtn: {
    width: 34,
    height: 34,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  textInput: {
    flex: 1,
    fontSize: 14.5,
    lineHeight: 20,
    paddingVertical: 7,
    paddingHorizontal: 4,
  },
});

function formatImageError(reason: ImageInputErrorReason, t: TranslateFn): string {
  if (reason === "too_large") return t("imageTooLargeToast");
  if (reason === "unsupported") return t("imageUnsupportedToast");
  return t("imageReadFailedToast");
}

export interface ChatComposerProps {
  theme: PluginTheme;
  butlerName: string;
  modelProviders: readonly CatalogProvider[];
  captureGlobalPaste: boolean;
  t: TranslateFn;
  onOpenModelPicker: () => void;
}

export const ChatComposer = memo(function ChatComposer({
  theme,
  butlerName,
  modelProviders,
  captureGlobalPaste,
  t,
  onOpenModelPicker,
}: ChatComposerProps) {
  const toast = useToast();
  const sendChatMessage = useRpc(sendChatMessageRpc);
  const tidySessions = useRpc(tidySessionsRpc);

  const draftText = useWishDraft();
  const draftImages = useWishDraftImages();
  const deepThinkEnabled = useDeepThinkEnabled();
  const selectedProvider = useSelectedConsoleProvider();
  const webImagesSupported = useMemo(() => isWebImageInputSupported(), []);

  const latestProactiveMsgId = useBotSelector((s) => {
    const msgs = s.messages ?? [];
    const last = msgs[msgs.length - 1];
    if (last && last.role === "assistant" && (last.kind === "proactive" || last.triggerId)) {
      return last.id;
    }
    return undefined;
  });

  const [menuOpen, setMenuOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [inputHeight, setInputHeight] = useState(36);
  const [tidying, setTidying] = useState(false);
  const capsuleRef = useRef<View>(null);

  const handleImageError = useCallback(
    (reason: ImageInputErrorReason) => {
      toast.show(formatImageError(reason, t), { variant: "warning" });
    },
    [t, toast],
  );

  const handleAppendImages = useCallback(
    (incoming: PastedImageItem[]) => {
      if (incoming.length === 0) return;
      const { truncated } = appendWishDraftImages(incoming, MAX_ATTACHED_IMAGES);
      if (truncated) {
        toast.show(t("imageLimitToast", { max: MAX_ATTACHED_IMAGES }), {
          variant: "warning",
        });
      }
    },
    [t, toast],
  );

  useEffect(() => {
    if (!webImagesSupported) return;
    return mountWebImagePasteTarget({
      container: capsuleRef.current,
      captureWindowPaste: captureGlobalPaste,
      onImages: handleAppendImages,
      onError: handleImageError,
      onDragActiveChange: setDragging,
    });
  }, [captureGlobalPaste, handleAppendImages, handleImageError, webImagesSupported]);

  const handlePickImages = useCallback(async () => {
    setMenuOpen(false);
    const picked = await pickWebImages(handleImageError);
    handleAppendImages(picked);
  }, [handleAppendImages, handleImageError]);

  const dispatchMessage = useCallback(
    async (overrideText?: string) => {
      const isQuickPrompt = typeof overrideText === "string";
      const clean = (isQuickPrompt ? overrideText : draftText).trim();
      const imagesSnapshot = isQuickPrompt ? [] : [...draftImages];
      if (!clean && imagesSnapshot.length === 0) return;

      setMenuOpen(false);
      if (!isQuickPrompt) {
        setWishDraft("");
        clearWishDraftImages();
        setInputHeight(36);
      }

      const previewImages = imagesSnapshot.map((img) => ({
        mimeType: img.mimeType,
        name: img.name,
        previewUri: img.previewUri,
      }));
      const rpcImages =
        imagesSnapshot.length > 0
          ? imagesSnapshot.map(({ data, mimeType, name }) => ({
              data,
              mimeType,
              ...(name ? { name } : {}),
            }))
          : undefined;

      const replyToId = latestProactiveMsgId;
      const optimisticId = optimisticAddChatMessage(clean, previewImages, replyToId);
      const finishSending = beginPendingChatSend();

      try {
        const res = await sendChatMessage({
          text: clean,
          images: rpcImages,
          replyToMessageId: replyToId,
          forceTier: deepThinkEnabled ? "L3" : undefined,
          providerOverride: selectedProvider || undefined,
        });
        confirmOptimisticChatMessage(optimisticId, res.userMessageId);
      } catch (err) {
        rollbackOptimisticChatMessage(optimisticId);
        if (!isQuickPrompt) {
          setWishDraft(clean);
          if (imagesSnapshot.length > 0) {
            setWishDraftImages(imagesSnapshot);
          }
        }
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        finishSending();
      }
    },
    [
      deepThinkEnabled,
      draftImages,
      draftText,
      latestProactiveMsgId,
      selectedProvider,
      sendChatMessage,
      toast,
    ],
  );

  const handleQuickTidy = useCallback(async () => {
    if (tidying) return;
    setMenuOpen(false);
    setTidying(true);
    toast.show(t("tidyRunningToast"), { variant: "info" });
    try {
      const res = await tidySessions({ mode: "preview" });
      if (res.actionCount > 0) {
        toast.show(t("tidyStagedToast", { count: res.actionCount }), {
          variant: "success",
        });
      } else {
        toast.show(t("tidyCleanToast"), { variant: "info" });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setTidying(false);
    }
  }, [t, tidySessions, tidying, toast]);

  const canSend = draftText.trim().length > 0 || draftImages.length > 0;
  const manualModelReadable = useMemo(
    () => (selectedProvider ? resolveModelLabel(selectedProvider, modelProviders) : ""),
    [modelProviders, selectedProvider],
  );

  return (
    <View
      style={[
        styles.outerWrap,
        { backgroundColor: theme.colors.surface0 },
      ]}
    >
      {menuOpen ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setMenuOpen(false)}
          style={[
            styles.menuBackdrop,
            Platform.OS === "web"
              ? ({ position: "fixed" } as unknown as ViewStyle)
              : null,
          ]}
        />
      ) : null}

      <View style={styles.maxContainer}>
        {menuOpen ? (
          <View
            style={[
              styles.plusPopover,
              {
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface1,
              },
            ]}
          >
            {webImagesSupported ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => void handlePickImages()}
                style={({ pressed }) => [
                  styles.menuItem,
                  { backgroundColor: pressed ? theme.colors.surface2 : "transparent" },
                ]}
              >
                <View style={styles.menuItemLeft}>
                  <Icon name="Image" size={15} color={theme.colors.accent} />
                  <Text style={[styles.menuItemTitle, { color: theme.colors.foreground }]}>
                    {t("chatMenuAddImage")}
                  </Text>
                </View>
              </Pressable>
            ) : null}

            <Pressable
              accessibilityRole="button"
              onPress={() => void dispatchMessage(t("quickPokeMorningWish"))}
              style={({ pressed }) => [
                styles.menuItem,
                { backgroundColor: pressed ? theme.colors.surface2 : "transparent" },
              ]}
            >
              <View style={styles.menuItemLeft}>
                <Icon name="Sun" size={15} color={theme.colors.foreground} />
                <Text style={[styles.menuItemTitle, { color: theme.colors.foreground }]}>
                  {t("quickPokeMorning")}
                </Text>
              </View>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              disabled={tidying}
              onPress={() => void handleQuickTidy()}
              style={({ pressed }) => [
                styles.menuItem,
                {
                  backgroundColor: pressed ? theme.colors.surface2 : "transparent",
                  opacity: tidying ? 0.6 : 1,
                },
              ]}
            >
              <View style={styles.menuItemLeft}>
                <Icon name="Layers" size={15} color={theme.colors.foreground} />
                <Text style={[styles.menuItemTitle, { color: theme.colors.foreground }]}>
                  {t("quickPokeTidy")}
                </Text>
              </View>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              onPress={() => void dispatchMessage(t("quickPokeInboxWish"))}
              style={({ pressed }) => [
                styles.menuItem,
                { backgroundColor: pressed ? theme.colors.surface2 : "transparent" },
              ]}
            >
              <View style={styles.menuItemLeft}>
                <Icon name="Folder" size={15} color={theme.colors.foreground} />
                <Text style={[styles.menuItemTitle, { color: theme.colors.foreground }]}>
                  {t("quickPokeInbox")}
                </Text>
              </View>
            </Pressable>

            <View
              style={[styles.menuDivider, { backgroundColor: theme.colors.border }]}
            />

            <Pressable
              accessibilityRole="switch"
              accessibilityState={{ checked: deepThinkEnabled }}
              onPress={() => {
                setDeepThinkEnabled(!deepThinkEnabled);
                setMenuOpen(false);
              }}
              style={({ pressed }) => [
                styles.menuItem,
                { backgroundColor: pressed ? theme.colors.surface2 : "transparent" },
              ]}
            >
              <View style={styles.menuItemLeft}>
                <Icon
                  name="Sparkles"
                  size={15}
                  color={
                    deepThinkEnabled ? theme.colors.accent : theme.colors.foregroundMuted
                  }
                />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.menuItemTitle, { color: theme.colors.foreground }]}>
                    {t("chatMenuDeepThink")}
                  </Text>
                  <Text
                    style={[styles.menuItemSub, { color: theme.colors.foregroundMuted }]}
                  >
                    {t("chatMenuDeepThinkDesc")}
                  </Text>
                </View>
              </View>
              {deepThinkEnabled ? (
                <Icon name="Check" size={14} color={theme.colors.accent} />
              ) : null}
            </Pressable>

            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setMenuOpen(false);
                onOpenModelPicker();
              }}
              style={({ pressed }) => [
                styles.menuItem,
                { backgroundColor: pressed ? theme.colors.surface2 : "transparent" },
              ]}
            >
              <View style={styles.menuItemLeft}>
                <Icon name="Cpu" size={15} color={theme.colors.foregroundMuted} />
                <Text style={[styles.menuItemTitle, { color: theme.colors.foreground }]}>
                  {t("chatMenuChooseModel")}
                </Text>
              </View>
              <Icon name="ChevronRight" size={13} color={theme.colors.foregroundMuted} />
            </Pressable>
          </View>
        ) : null}

        {deepThinkEnabled || selectedProvider ? (
          <View style={styles.modePillsRow}>
            {deepThinkEnabled ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setDeepThinkEnabled(false)}
                style={[
                  styles.modePill,
                  {
                    borderColor: theme.colors.accent,
                    backgroundColor: theme.colors.surface1,
                  },
                ]}
              >
                <Icon name="Sparkles" size={11} color={theme.colors.accent} />
                <Text style={[styles.modePillText, { color: theme.colors.accent }]}>
                  {t("deepThinkBadge")}
                </Text>
                <Icon name="X" size={11} color={theme.colors.accent} />
              </Pressable>
            ) : null}

            {selectedProvider ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setSelectedConsoleProvider(null)}
                style={[
                  styles.modePill,
                  {
                    borderColor: theme.colors.border,
                    backgroundColor: theme.colors.surface1,
                  },
                ]}
              >
                <Icon name="Cpu" size={11} color={theme.colors.foregroundMuted} />
                <Text style={[styles.modePillText, { color: theme.colors.foreground }]}>
                  {t("manualModelBadge", {
                    model: manualModelReadable || selectedProvider,
                  })}
                </Text>
                <Icon name="X" size={11} color={theme.colors.foregroundMuted} />
              </Pressable>
            ) : null}
          </View>
        ) : null}

        <View
          ref={capsuleRef}
          style={[
            styles.capsuleShell,
            {
              borderColor: dragging ? theme.colors.accent : theme.colors.border,
              backgroundColor: theme.colors.surface1,
            },
          ]}
        >
          {draftImages.length > 0 ? (
            <View style={styles.imageStripRow}>
              {draftImages.map((img) => (
                <View key={img.id} style={styles.thumbWrap}>
                  <Image
                    source={{ uri: img.previewUri }}
                    accessibilityLabel={img.name || t("attachImage")}
                    style={[
                      styles.thumbImg,
                      {
                        borderColor: theme.colors.border,
                        backgroundColor: theme.colors.surface2,
                      },
                    ]}
                    resizeMode="cover"
                  />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("removeImageA11y")}
                    onPress={() => removeWishDraftImage(img.id)}
                    style={[
                      styles.thumbRemoveBtn,
                      {
                        borderColor: theme.colors.border,
                        backgroundColor: theme.colors.surface1,
                      },
                    ]}
                  >
                    <Icon name="X" size={10} color={theme.colors.foreground} />
                  </Pressable>
                </View>
              ))}
            </View>
          ) : null}

          {dragging ? (
            <View style={styles.dropBanner}>
              <Icon name="Image" size={13} color={theme.colors.accent} />
              <Text style={[styles.dropBannerText, { color: theme.colors.accent }]}>
                {t("dropImagesHint")}
              </Text>
            </View>
          ) : null}

          <View style={styles.inputRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("chatComposerPlusA11y")}
              onPress={() => setMenuOpen((v) => !v)}
              style={[
                styles.circleIconBtn,
                {
                  backgroundColor: menuOpen
                    ? theme.colors.surface2
                    : "transparent",
                },
              ]}
            >
              <Icon
                name={menuOpen ? "X" : "Plus"}
                size={20}
                color={theme.colors.foreground}
              />
            </Pressable>

            <TextInput
              value={draftText}
              onChangeText={(txt) => {
                setWishDraft(txt);
                if (!txt) setInputHeight(36);
              }}
              onKeyPress={(e) => {
                if (isChatEnterSubmitKey(e)) {
                  void dispatchMessage();
                }
              }}
              onContentSizeChange={(e) => {
                const nextH = e.nativeEvent?.contentSize?.height;
                if (typeof nextH === "number" && Number.isFinite(nextH)) {
                  setInputHeight(Math.max(36, Math.min(136, Math.ceil(nextH + 6))));
                }
              }}
              multiline
              placeholder={t("chatComposerPlaceholder", { name: butlerName })}
              placeholderTextColor={theme.colors.foregroundMuted}
              style={[
                styles.textInput,
                {
                  height: inputHeight,
                  maxHeight: 136,
                  color: theme.colors.foreground,
                },
              ]}
            />

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("chatComposerSendA11y")}
              disabled={!canSend}
              onPress={() => void dispatchMessage()}
              style={[
                styles.circleIconBtn,
                {
                  backgroundColor: canSend
                    ? theme.colors.accent
                    : theme.colors.surface2,
                  opacity: canSend ? 1 : 0.65,
                },
              ]}
            >
              <Icon
                name="ArrowUp"
                size={17}
                color={
                  canSend ? theme.colors.accentForeground : theme.colors.foregroundMuted
                }
              />
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
});
