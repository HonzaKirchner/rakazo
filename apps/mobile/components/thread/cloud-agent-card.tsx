import { ChatMarkdown } from "@rakazo/chat-ui/native";
import type { MessageBlock } from "@rakazo/contracts";
import {
  CLOUD_AGENT_SPARK_FRAMES,
  CLOUD_AGENT_SPARK_STILL,
  CLOUD_AGENT_SPARK_TICK_MS,
  cloudAgentHttpsUrl,
  plainTextFromMarkdown,
} from "@rakazo/core";
import { typeScale } from "@rakazo/ui-tokens";
import { useEffect, useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { mobileTokens } from "../../lib/appearance";
import { transparentColor } from "../../lib/color";
import { useI18n } from "../../lib/i18n";
import { useResolvedAppearance } from "../../lib/native";
import type { UserBubble } from "../../lib/user-bubble";
import { withUserBubble } from "../../lib/user-bubble";
import { NativeSymbol } from "../native-symbol";
import type { MessageActionProps } from "./message-bubble";

type CloudAgentBlock = Extract<MessageBlock, { kind: "cloud_agent" }>;

/** A strip along the card's top edge that pulses while the agent works. */
function RunningBar({ color }: { color: string }) {
  const reducedMotion = useReducedMotion();
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (reducedMotion) return;
    opacity.value = withRepeat(withTiming(0.25, { duration: 800 }), -1, true);
    return () => cancelAnimation(opacity);
  }, [opacity, reducedMotion]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={[{ height: 3, backgroundColor: color }, style]} />;
}

/** A running agent's star, blooming and folding back; still when motion is reduced. */
function Spark({ color }: { color: string }) {
  const reducedMotion = useReducedMotion();
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (reducedMotion) return;
    const timer = setInterval(
      () => setFrame((current) => (current + 1) % CLOUD_AGENT_SPARK_FRAMES.length),
      CLOUD_AGENT_SPARK_TICK_MS,
    );
    return () => clearInterval(timer);
  }, [reducedMotion]);
  return (
    <Text style={{ color, fontSize: 20, lineHeight: 24 }}>
      {reducedMotion ? CLOUD_AGENT_SPARK_STILL : CLOUD_AGENT_SPARK_FRAMES[frame]}
    </Text>
  );
}

const STATUS_SYMBOL = {
  finished: { ios: "checkmark", android: "checkmark" },
  failed: { ios: "xmark", android: "close" },
  cancelled: { ios: "nosign", android: "close-circle" },
  expired: { ios: "clock", android: "time-outline" },
} as const;

// Live updates replace the block, so remember open cards by agent id across them.
const openCloudAgents = new Set<string>();

/**
 * A cloud agent's card: title, status, where the work landed and the start of the agent's final
 * reply, opening to the whole reply and what it was launched with. While an agent runs and its
 * card is scrolled out of view, a copy sticks above the composer.
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
  const toggle = () => {
    if (open) openCloudAgents.delete(special.agentId);
    else openCloudAgents.add(special.agentId);
    setOpen(!open);
  };
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
  const tone =
    special.status === "finished"
      ? tokens.success
      : special.status === "failed"
        ? tokens.destructive
        : special.status === "running"
          ? tokens.foreground
          : tokens.mutedForeground;
  const prHref = cloudAgentHttpsUrl(special.prUrl);
  const agentHref = cloudAgentHttpsUrl(special.url);
  // Folded, the start of the reply, or of the prompt until there is a reply.
  const preview = open
    ? ""
    : special.summary
      ? plainTextFromMarkdown(special.summary)
      : (special.prompt ?? "");
  const label = { color: tokens.mutedForeground, ...typeScale.caption };
  const value = { color: tokens.cardForeground, marginTop: 2, ...typeScale.secondary };
  const detailsStyle = {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 16,
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: tokens.border,
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
    </>
  );
  return (
    <View
      testID={pinned ? "pinned-cloud-agent" : "cloud-agent-card"}
      style={{
        width: "100%",
        maxWidth: 560,
        marginBottom: pinned ? 8 : 0,
        borderRadius: 20,
        backgroundColor: tokens.card,
        borderWidth: running ? 1.5 : 1,
        borderColor: running ? tokens.foreground : tokens.border,
        boxShadow: running ? "0 8px 24px rgba(0, 0, 0, 0.16)" : "0 4px 16px rgba(0, 0, 0, 0.08)",
      }}
    >
      <View style={{ borderRadius: 19, overflow: "hidden" }}>
        {running ? (
          <RunningBar color={tokens.foreground} />
        ) : (
          <View
            style={{
              height: 3,
              backgroundColor: tone,
              opacity: tone === tokens.mutedForeground ? 0.4 : 1,
            }}
          />
        )}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14 }}>
          {/* The whole header opens the card; the links sit above this button. */}
          <Pressable
            {...actionProps}
            onPress={toggle}
            accessibilityRole="button"
            accessibilityLabel={`${title}: ${statusLabel}`}
            accessibilityState={{ expanded: open }}
            style={StyleSheet.absoluteFill}
          />
          <View
            pointerEvents="none"
            style={{
              width: 40,
              height: 40,
              borderRadius: 12,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: running ? tokens.foreground : tokens.muted,
            }}
          >
            {special.status === "running" ? (
              <Spark color={tokens.background} />
            ) : (
              <NativeSymbol
                ios={STATUS_SYMBOL[special.status].ios}
                android={STATUS_SYMBOL[special.status].android}
                size={18}
                weight="bold"
                color={tone}
              />
            )}
          </View>
          <View pointerEvents="box-none" style={{ flex: 1, gap: 2 }}>
            <Text
              accessible={false}
              pointerEvents="none"
              numberOfLines={open ? undefined : 1}
              style={{ color: tokens.cardForeground, ...typeScale.cardTitle, fontWeight: "600" }}
            >
              {title}
            </Text>
            <View
              pointerEvents="box-none"
              style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
            >
              <Text
                accessible={false}
                pointerEvents="none"
                style={{ color: tone, fontWeight: "500", ...typeScale.footnote }}
              >
                {statusLabel}
                {prHref || special.branch ? " ·" : ""}
              </Text>
              {prHref ? (
                <Pressable
                  accessibilityRole="link"
                  onPress={() => Linking.openURL(prHref).catch(() => undefined)}
                  hitSlop={10}
                >
                  <Text
                    style={{
                      color: tokens.foreground,
                      textDecorationLine: "underline",
                      ...typeScale.footnote,
                    }}
                  >
                    {t("Pull request")}
                  </Text>
                </Pressable>
              ) : special.branch ? (
                <Text
                  accessible={false}
                  pointerEvents="none"
                  numberOfLines={1}
                  style={{ flexShrink: 1, color: tokens.mutedForeground, ...typeScale.footnote }}
                >
                  {special.branch}
                </Text>
              ) : null}
            </View>
          </View>
          {agentHref ? (
            <Pressable
              onPress={() => Linking.openURL(agentHref).catch(() => undefined)}
              accessibilityRole="link"
              accessibilityLabel={t("Open cloud agent")}
              hitSlop={6}
              style={{
                width: 34,
                height: 34,
                borderRadius: 17,
                alignItems: "center",
                justifyContent: "center",
                borderWidth: 1,
                borderColor: tokens.border,
              }}
            >
              <NativeSymbol
                ios="arrow.up.right"
                android="open-outline"
                size={14}
                color={tokens.mutedForeground}
              />
            </Pressable>
          ) : null}
        </View>
        {preview ? (
          <Pressable
            onPress={toggle}
            accessible={false}
            style={{ paddingHorizontal: 16, paddingBottom: 16, marginTop: -4 }}
          >
            <Text
              numberOfLines={2}
              style={{ color: tokens.cardForeground, ...typeScale.secondary }}
            >
              {preview}
            </Text>
            {/* The second line fades into the card. */}
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                start: 0,
                end: 0,
                bottom: 16,
                height: typeScale.secondary.lineHeight,
                experimental_backgroundImage: `linear-gradient(to bottom, ${transparentColor(tokens.card)} 0%, ${tokens.card} 100%)`,
              }}
            />
          </Pressable>
        ) : null}
        {open && pinned ? (
          // Pinned above the composer, a long reply scrolls inside the card.
          <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={detailsStyle}>
            {details}
          </ScrollView>
        ) : open ? (
          <View style={detailsStyle}>{details}</View>
        ) : null}
      </View>
    </View>
  );
}

/** The newest running cloud agent's card, stuck above the composer while it is out of view. */
export function PinnedCloudAgent({ block }: { block: CloudAgentBlock }) {
  return <CloudAgentCard special={block} pinned />;
}
