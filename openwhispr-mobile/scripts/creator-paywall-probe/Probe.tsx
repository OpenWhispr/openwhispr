import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, ScrollView, Text, View } from 'react-native';
import * as Application from 'expo-application';
import {
  CustomPurchaseControllerProvider,
  SuperwallProvider,
  usePlacement,
  useSuperwall,
} from 'expo-superwall';
import { createProbeCallback, probeParams, PROBE_PLACEMENT, type ProbeScenario } from './callback';

export const PROBE_BUNDLE_ID = 'com.openwhispr.creatorcode.probe20260925';
const PAYWALL_IDENTIFIER = 'creator-code-test-draft-2026-09-25-0393-2026-09-25';
const PAYWALL_NAME = 'Creator Code TEST DRAFT 2026-09-25';

type PresentationProps = {
  append: (event: string) => void;
  finish: () => void;
  scenario: ProbeScenario;
};
function ProbePresentation({ append, finish, scenario }: PresentationProps) {
  const probe = useMemo(
    () => createProbeCallback((shape) => append(shape.join('\n')), scenario),
    [append, scenario],
  );
  const started = useRef(false);
  const presented = useRef(false);
  const dismiss = useSuperwall((state) => state.dismiss);
  const stop = () => {
    probe.close();
    finish();
  };
  const { registerPlacement } = usePlacement({
    onCustomCallback: (callback) => probe.handle(callback),
    onPresent: (info) => {
      presented.current = true;
      append(`Presented: ${info.name} (${info.identifier})`);
      if (info.name !== PAYWALL_NAME || info.identifier !== PAYWALL_IDENTIFIER) {
        probe.close();
        append('Unexpected paywall; refusing callbacks and dismissing');
        dismiss().catch(() => append('Dismiss failed; close manually'));
      }
    },
    onDismiss: (_info, result) => {
      append(`Dismissed: ${result.type}`);
      stop();
    },
    onSkip: (reason) => {
      append(`Skipped: ${reason.type}`);
      stop();
    },
    onError: () => {
      append('Presentation error');
      stop();
    },
  });
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    append(`Placement: ${PROBE_PLACEMENT}; fixture: ${scenario}`);
    registerPlacement({
      placement: PROBE_PLACEMENT,
      params: probeParams(scenario),
    })
      .then(() => {
        if (!presented.current) stop();
      })
      .catch(() => {
        append('Registration failed');
        stop();
      });
  });
  useEffect(() => () => probe.close(), [probe]);
  return null;
}

function ProbeScreen({ append, events }: { append: (event: string) => void; events: string[] }) {
  const [ready, setReady] = useState(false);
  const [presentation, setPresentation] = useState<{ id: number; scenario: ProbeScenario } | null>(
    null,
  );
  const nextId = useRef(0);
  const configured = useSuperwall((state) => state.isConfigured);
  const setSubscriptionStatus = useSuperwall((state) => state.setSubscriptionStatus);
  useEffect(() => {
    if (!configured) return;
    let active = true;
    setSubscriptionStatus({ status: 'INACTIVE' })
      .then(() => {
        if (active) setReady(true);
      })
      .catch(() => append('Could not initialize fictional subscription state'));
    return () => {
      active = false;
    };
  }, [configured, setSubscriptionStatus, append]);
  return (
    <View style={{ flex: 1, padding: 24, paddingTop: 70 }}>
      <Text style={{ fontSize: 24 }}>Creator callback probe</Text>
      <Text>
        Fictional input: DEMO_ONLY. Purchases, restore and redemption are disabled. No OpenWhispr
        API, attribution or billing services are loaded.
      </Text>
      {(
        [
          'valid',
          'seed',
          'seed-missing',
          'retry-missing',
          'missing',
          'malformed',
          'failure',
          'slow',
        ] as const
      ).map((scenario) => (
        <Button
          key={scenario}
          title={`Open ${scenario} fixture`}
          disabled={!ready || presentation !== null}
          onPress={() => setPresentation({ id: nextId.current++, scenario })}
        />
      ))}
      {presentation !== null && (
        <ProbePresentation
          key={presentation.id}
          scenario={presentation.scenario}
          append={append}
          finish={() => setPresentation((current) => (current === presentation ? null : current))}
        />
      )}
      <ScrollView>
        {events.map((event, i) => (
          <Text key={i} style={{ marginVertical: 8 }}>
            {event}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

// Standalone entry only, cold-launched in a distinct native application. Never
// import into the customer app: native Superwall configuration is one-shot.
export default function Probe() {
  const [events, setEvents] = useState<string[]>([]);
  const append = React.useCallback(
    (event: string) => setEvents((old) => [...old.slice(-15), event]),
    [],
  );
  const controller = useMemo(
    () => ({
      onPurchase: async ({ productId }: { productId: string }) => {
        append(`Purchase refused: ${productId}`);
        return { type: 'cancelled' as const };
      },
      onPurchaseRestore: async () => {
        append('Restore refused');
        return { type: 'failed' as const, error: 'Restore disabled in fixture probe' };
      },
    }),
    [append],
  );
  const apiKey = process.env.EXPO_PUBLIC_CREATOR_PROBE_SUPERWALL_KEY;
  if (!__DEV__ || !apiKey || Application.applicationId !== PROBE_BUNDLE_ID)
    return <Text>Probe requires its separate development binary and public SDK key.</Text>;
  return (
    <CustomPurchaseControllerProvider controller={controller}>
      <SuperwallProvider
        apiKeys={{ ios: apiKey }}
        options={{ testModeBehavior: 'never', logging: { level: 'error', scopes: [] } }}
      >
        <ProbeScreen append={append} events={events} />
      </SuperwallProvider>
    </CustomPurchaseControllerProvider>
  );
}
