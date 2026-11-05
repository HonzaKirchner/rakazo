import { ChatMarkdown } from "@rakazo/chat-ui/native";
import type { MessageBlock } from "@rakazo/contracts";
import { cloudAgentHttpsUrl } from "@rakazo/core";
import { typeScale } from "@rakazo/ui-tokens";
import { useEffect, useState } from "react";
import { Linking, Pressable, ScrollView, Text, View } from "react-native";
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
import { useResolvedAppearance } from "../../lib/native";
import type { UserBubble } from "../../lib/user-bubble";
import { withUserBubble } from "../../lib/user-bubble";
import { NativeSymbol } from "../native-symbol";
import type { MessageActionProps } from "./message-bubble";

type CloudAgentBlock = Extract<MessageBlock, { kind: "cloud_agent" }>;

/** A pulsing dot that marks a cloud agent as still working. */
function CloudAgentRunningDot({ color }: { color: string }) {
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

// Live updates replace the block, so remember open cards by agent id across them.
const openCloudAgents = new Set<string>();

/**
 * A cloud agent's card: title, status and where the work landed, opening to the agent's final
 * reply and what it was launched with. While an agent runs, its card is pinned above the
 * composer instead of sitting in the transcript.
 */
export function CloudAgentCard({
  special,
  actionProps,
  userBubble,
  pinned = false,
}: {
  special: CloudAgentBlock;
  actionProps?: MessageActionProps;
  userBubble?: UserBubble;
  pinned?: boolean;
}) {
  const colorScheme = useResolvedAppearance();
  const tokens = withUserBubble(mobileTokens(), userBubble);
  const { t } = useI18n();
  const [open, setOpen] = useState(() => openCloudAgents.has(special.agentId));
  const title = special.title || t("Cloud agent");
  const statusLabel =
    special.status === "running"
      ? t("running")
      : special.status === "finished"
        ? t("finished")
        : special.status === "cancelled"
          ? t("cancelled")
          : special.status === "expired"
            ? t("expired")
            : t("failed");
  const running = special.status === "running";
  const failed = special.status !== "running" && special.status !== "finished";
  const prHref = cloudAgentHttpsUrl(special.prUrl);
  const href = prHref ?? cloudAgentHttpsUrl(special.url);
  const label = { color: tokens.mutedForeground, ...typeScale.caption };
  const value = { color: tokens.cardForeground, marginTop: 2, ...typeScale.secondary };
  const detailsStyle = {
    paddingHorizontal: pinned ? 18 : 16,
    paddingBottom: 14,
    marginTop: -4,
    gap: 10,
  };
  const details = (
    <>
      {special.summary ? (
        <ChatMarkdown palette={tokens} colorScheme={colorScheme}>
          {special.summary}
        </ChatMarkdown>
      ) : null}
      {special.prompt ? (
        <View>
          <Text style={label}>{t("Prompt")}</Text>
          <Text selectable style={value}>
            {special.prompt}
          </Text>
        </View>
      ) : null}
      {special.repository ? (
        <View>
          <Text style={label}>{t("Repository")}</Text>
          <Text selectable style={value}>
            {special.repository}
          </Text>
        </View>
      ) : null}
      {special.openPr ? <Text style={label}>{t("Opens a pull request")}</Text> : null}
      {special.imageCount ? (
        <View>
          <Text style={label}>{t("Images")}</Text>
          <Text style={value}>{special.imageCount}</Text>
        </View>
      ) : null}
      {href ? (
        <Pressable
          onPress={() => Linking.openURL(href).catch(() => undefined)}
          accessibilityRole="link"
          hitSlop={8}
          style={{ alignSelf: "flex-start", minHeight: 44, justifyContent: "center" }}
        >
          <Text style={{ color: tokens.foreground, ...typeScale.secondary }}>
            {prHref ? t("Open pull request") : t("Open cloud agent")}
          </Text>
        </Pressable>
      ) : null}
    </>
  );
  return (
    <View
      testID={pinned ? "pinned-cloud-agent" : "cloud-agent-card"}
      style={{
        width: pinned ? "100%" : "90%",
        marginTop: pinned ? 8 : 0,
        borderRadius: pinned ? 22 : 18,
        backgroundColor: tokens.card,
        ...(running
          ? { borderWidth: 1.5, borderColor: tokens.foreground }
          : pinned
            ? { borderWidth: 1, borderColor: tokens.border }
            : {}),
      }}
    >
      <Pressable
        {...actionProps}
        onPress={() => {
          if (open) openCloudAgents.delete(special.agentId);
          else openCloudAgents.add(special.agentId);
          setOpen(!open);
        }}
        accessibilityRole="button"
        accessibilityLabel={`${title}: ${statusLabel}`}
        accessibilityState={{ expanded: open }}
        style={{ paddingHorizontal: pinned ? 18 : 16, paddingVertical: 14, minHeight: 44 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text
            style={{
              flexShrink: 1,
              flexGrow: 1,
              color: tokens.cardForeground,
              ...(pinned ? typeScale.headline : typeScale.cardTitle),
            }}
          >
            {title}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            {running ? <CloudAgentRunningDot color={tokens.foreground} /> : null}
            <Text
              style={{
                color: failed ? tokens.destructive : running ? tokens.foreground : tokens.success,
                ...typeScale.caption,
              }}
            >
              {statusLabel}
            </Text>
          </View>
          <NativeSymbol
            ios={open ? "chevron.up" : "chevron.down"}
            android={open ? "chevron-up" : "chevron-down"}
            size={12}
            color={tokens.mutedForeground}
          />
        </View>
        {prHref ? (
          <Text style={{ color: tokens.mutedForeground, marginTop: 8, ...typeScale.secondary }}>
            {t("Pull request")}
          </Text>
        ) : special.branch ? (
          <Text style={{ color: tokens.mutedForeground, marginTop: 8, ...typeScale.secondary }}>
            {special.branch}
          </Text>
        ) : null}
      </Pressable>
      {open && pinned ? (
        // Pinned above the composer, a long reply scrolls inside the card.
        <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={detailsStyle}>
          {details}
        </ScrollView>
      ) : open ? (
        <View style={detailsStyle}>{details}</View>
      ) : null}
    </View>
  );
}

/** The newest running cloud agent, kept above the composer while the messages scroll. */
export function PinnedCloudAgent({ block }: { block: CloudAgentBlock }) {
  return <CloudAgentCard special={block} pinned />;
}
