import type { MessageBlock } from "@rakazo/contracts";
import { cloudAgentHttpsUrl } from "@rakazo/core";
import { typeScale } from "@rakazo/ui-tokens";
import { useEffect } from "react";
import { Linking, Pressable, Text } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";

/** A pulsing dot that marks a cloud agent as still working. */
export function CloudAgentRunningDot({ color }: { color: string }) {
  const reducedMotion = useReducedMotion();
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (reducedMotion) return;
    opacity.value = withRepeat(withTiming(0.3, { duration: 800 }), -1, true);
    return () => cancelAnimation(opacity);
  }, [opacity, reducedMotion]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      style={[{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }, style]}
    />
  );
}

/** The running cloud agent, kept above the composer while the messages scroll. */
export function PinnedCloudAgent({
  block,
}: {
  block: Extract<MessageBlock, { kind: "cloud_agent" }>;
}) {
  const tokens = mobileTokens();
  const { t } = useI18n();
  const href = cloudAgentHttpsUrl(block.url);
  const title = block.title || t("Cloud agent");
  return (
    <Pressable
      testID="pinned-cloud-agent"
      accessibilityRole={href ? "link" : "text"}
      accessibilityLabel={`${title}: ${t("running")}`}
      disabled={!href}
      onPress={() => {
        if (href) Linking.openURL(href).catch(() => undefined);
      }}
      style={{
        marginTop: 8,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        minHeight: 44,
        borderRadius: 999,
        borderWidth: 1.5,
        borderColor: tokens.foreground,
        backgroundColor: tokens.card,
        paddingHorizontal: 16,
        paddingVertical: 10,
      }}
    >
      <CloudAgentRunningDot color={tokens.foreground} />
      <Text
        numberOfLines={1}
        style={{ flex: 1, color: tokens.cardForeground, ...typeScale.cardTitle }}
      >
        {title}
      </Text>
      <Text style={{ color: tokens.mutedForeground, ...typeScale.caption }}>{t("running")}</Text>
    </Pressable>
  );
}
