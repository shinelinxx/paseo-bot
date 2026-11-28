import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Platform,
  StyleSheet,
  useColorScheme,
  View,
  type ViewStyle,
} from "react-native";
import { isDarkSurfaceColor } from "./helpers";

type PluginTheme = PluginScreenProps["theme"];

export interface ButlerAvatarProps {
  theme: PluginTheme;
  size?: number;
  thinking?: boolean;
  paused?: boolean;
}

interface CloudPuffGeometry {
  key: string;
  width: number;
  height: number;
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

const styles = StyleSheet.create({
  wrapper: {
    alignItems: "center",
    justifyContent: "center",
  },
  aura: {
    position: "absolute",
    borderRadius: 999,
  },
  cloudCanvas: {
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
  },
  layerGroup: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  puff: {
    position: "absolute",
    borderRadius: 999,
  },
  eyesRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  eye: {
    borderRadius: 999,
  },
});

function detectDarkAppearance(
  rawSurface0: string,
  systemScheme: string | null | undefined,
): boolean {
  const c = rawSurface0.trim();
  if (/^#|^rgba?\(/i.test(c)) {
    return isDarkSurfaceColor(c);
  }
  const hslMatch = /^hsla?\(\s*[\d.]+\s*,\s*[\d.]+%\s*,\s*([\d.]+)%/i.exec(c);
  if (hslMatch) {
    return Number.parseFloat(hslMatch[1]) < 45;
  }
  const oklchMatch = /^oklch\(\s*([\d.]+)(%?)/i.exec(c);
  if (oklchMatch) {
    const val = Number.parseFloat(oklchMatch[1]);
    return oklchMatch[2] === "%" ? val < 48 : val < 0.48;
  }
  if (Platform.OS === "web") {
    const doc = (
      globalThis as unknown as {
        document?: {
          documentElement?: {
            classList?: { contains?(cls: string): boolean };
            getAttribute?(attr: string): string | null;
          };
        };
      }
    ).document?.documentElement;
    if (doc?.classList?.contains?.("dark")) return true;
    if (doc?.classList?.contains?.("light")) return false;
    const dataTheme = doc?.getAttribute?.("data-theme")?.toLowerCase();
    if (dataTheme?.includes("dark")) return true;
    if (dataTheme?.includes("light")) return false;
  }
  return systemScheme === "dark";
}

function renderCloudPuffs(
  puffs: readonly CloudPuffGeometry[],
  color: string,
  expandPx = 0,
) {
  const half = expandPx / 2;
  return puffs.map((p) => (
    <View
      key={p.key}
      style={[
        styles.puff,
        {
          width: p.width + expandPx,
          height: p.height + expandPx,
          ...(p.top !== undefined ? { top: p.top - half } : {}),
          ...(p.bottom !== undefined ? { bottom: p.bottom - half } : {}),
          ...(p.left !== undefined ? { left: p.left - half } : {}),
          ...(p.right !== undefined ? { right: p.right - half } : {}),
          backgroundColor: color,
        },
      ]}
    />
  ));
}

export const ButlerAvatar = memo(function ButlerAvatar({
  theme,
  size = 42,
  thinking = false,
  paused = false,
}: ButlerAvatarProps) {
  const pulse = useRef(new Animated.Value(0)).current;
  const [webAuraBright, setWebAuraBright] = useState(false);
  const systemScheme = useColorScheme();

  const isDark = useMemo(
    () => detectDarkAppearance(theme.colors.surface0, systemScheme),
    [theme.colors.surface0, systemScheme],
  );

  // On Web, avoid 60fps JS rAF scaling across 28 cloud nodes; use a single compositor-friendly
  // opacity transition on the outer aura. On iOS/Android native, use native-driver animation.
  useEffect(() => {
    if (!thinking) {
      if (Platform.OS === "web") {
        setWebAuraBright(false);
      } else {
        pulse.stopAnimation();
        pulse.setValue(0);
      }
      return;
    }

    if (Platform.OS === "web") {
      setWebAuraBright(true);
      const timer = setInterval(() => {
        setWebAuraBright((v) => !v);
      }, 950);
      return () => clearInterval(timer);
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1050,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 1050,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, thinking]);

  const puffs = useMemo<CloudPuffGeometry[]>(() => {
    const core = Math.round(size * 0.7);
    const puffLg = Math.round(size * 0.48);
    const puffMd = Math.round(size * 0.43);
    const coreOffset = Math.round((size - core) / 2);
    return [
      {
        key: "top",
        width: puffLg,
        height: puffLg,
        top: Math.round(size * 0.04),
        left: Math.round((size - puffLg) / 2),
      },
      {
        key: "tl",
        width: puffMd,
        height: puffMd,
        top: Math.round(size * 0.17),
        left: Math.round(size * 0.06),
      },
      {
        key: "tr",
        width: puffMd,
        height: puffMd,
        top: Math.round(size * 0.17),
        right: Math.round(size * 0.06),
      },
      {
        key: "bl",
        width: puffMd,
        height: puffMd,
        bottom: Math.round(size * 0.13),
        left: Math.round(size * 0.09),
      },
      {
        key: "br",
        width: puffMd,
        height: puffMd,
        bottom: Math.round(size * 0.13),
        right: Math.round(size * 0.09),
      },
      {
        key: "bottom",
        width: puffLg,
        height: puffLg,
        bottom: Math.round(size * 0.04),
        left: Math.round((size - puffLg) / 2),
      },
      {
        key: "core",
        width: core,
        height: core,
        top: coreOffset,
        left: coreOffset,
      },
    ];
  }, [size]);

  const nativeScale = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.07],
  });
  const nativeAuraOpacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.12, 0.3],
  });

  const baseFill = isDark ? theme.colors.surface2 : theme.colors.surface1;
  const contourGroupOpacity = isDark ? 0.9 : 0.16;
  const bodyTintGroupOpacity = isDark ? 0.78 : 0.055;
  const eyeColor = isDark ? theme.colors.surface0 : theme.colors.foreground;
  const eyeOpacity = paused ? 0.48 : 0.9;

  const eyeW = Math.max(2.6, Math.round(size * 0.085 * 10) / 10);
  const eyeH = Math.max(5, Math.round(size * (paused ? 0.11 : 0.19)));
  const eyeGap = Math.max(4, Math.round(size * 0.12));

  const isNativeAnimated = Platform.OS !== "web" && thinking;

  return (
    <View style={[styles.wrapper, { width: size + 8, height: size + 6 }]}>
      {thinking ? (
        Platform.OS === "web" ? (
          <View
            pointerEvents="none"
            style={[
              styles.aura,
              {
                width: size + 8,
                height: size + 8,
                backgroundColor: theme.colors.accent,
                opacity: webAuraBright ? 0.28 : 0.1,
              },
              {
                transitionProperty: "opacity",
                transitionDuration: "900ms",
              } as unknown as ViewStyle,
            ]}
          />
        ) : (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.aura,
              {
                width: size + 8,
                height: size + 8,
                backgroundColor: theme.colors.accent,
                opacity: nativeAuraOpacity,
                transform: [{ scale: nativeScale }],
              },
            ]}
          />
        )
      ) : null}

      <Animated.View
        style={[
          styles.cloudCanvas,
          {
            width: size,
            height: size,
            transform: isNativeAnimated ? [{ scale: nativeScale }] : undefined,
          },
        ]}
      >
        <View pointerEvents="none" style={styles.layerGroup}>
          {renderCloudPuffs(puffs, baseFill, 2.4)}
        </View>
        <View
          pointerEvents="none"
          style={[styles.layerGroup, { opacity: contourGroupOpacity }]}
        >
          {renderCloudPuffs(puffs, theme.colors.foreground, 2.4)}
        </View>

        <View pointerEvents="none" style={styles.layerGroup}>
          {renderCloudPuffs(puffs, baseFill, 0)}
        </View>
        <View
          pointerEvents="none"
          style={[styles.layerGroup, { opacity: bodyTintGroupOpacity }]}
        >
          {renderCloudPuffs(puffs, theme.colors.foreground, 0)}
        </View>

        <View style={[styles.eyesRow, { gap: eyeGap, opacity: eyeOpacity }]}>
          <View
            style={[
              styles.eye,
              {
                width: eyeW,
                height: eyeH,
                backgroundColor: eyeColor,
              },
            ]}
          />
          <View
            style={[
              styles.eye,
              {
                width: eyeW,
                height: eyeH,
                backgroundColor: eyeColor,
              },
            ]}
          />
        </View>
      </Animated.View>
    </View>
  );
});
