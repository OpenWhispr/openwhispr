// Copyright (c) 2025 Jonas van den Berg
// This file is licensed under the BSD 3-Clause License.

#ifndef MEDIAREMOTEADAPTER_ADAPTER_KEYS_H
#define MEDIAREMOTEADAPTER_ADAPTER_KEYS_H

#import <Foundation/Foundation.h>

// These keys are mandatory and must never be null, empty or missing.
NSArray<NSString *> *mandatoryPayloadKeys(void);

// Checks whether all mandatory payload keys returned by mandatoryPayloadKeys()
// are present in the given payload dictionary and have a non-null value.
bool allMandatoryPayloadKeysSet(NSDictionary *data);

// These keys identify a now playing item uniquely.
NSArray<NSString *> *identifyingPayloadKeys(void);

#endif // MEDIAREMOTEADAPTER_ADAPTER_KEYS_H
