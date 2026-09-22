export type ShareVisibility = 'private' | 'link' | 'domain' | 'invited';
export type NotePermission = 'owner' | 'editor' | 'viewer';
export type NoteAccessPrincipalType = 'user' | 'email' | 'team' | 'folder' | 'workspace';

export interface NoteAccessPrincipal {
  type: NoteAccessPrincipalType;
  id: string | null;
  email: string | null;
  name: string | null;
  image: string | null;
  member_count: number | null;
}

export interface NoteAccessGrant {
  id: string;
  principal: NoteAccessPrincipal;
  permission: Exclude<NotePermission, 'owner'>;
  source: 'direct' | 'team' | 'folder' | 'workspace';
  inherited: boolean;
  pending: boolean;
  created_at: string;
  updated_at: string;
}

export interface NoteAccessState {
  owner: NoteAccessPrincipal;
  grants: NoteAccessGrant[];
  my_permission: NotePermission;
  can_manage_access: boolean;
  can_manage_inherited_access: boolean;
}

export interface ShareSettings {
  visibility: ShareVisibility;
  token_prefix: string | null;
  domain_allowlist: string[];
  updated_by_user_id: string | null;
  updated_at: string | null;
}

export interface NoteShareInvitation {
  id: string;
  email: string;
  invited_by_user_id: string;
  accepted_at: string | null;
  revoked_at: string | null;
  last_emailed_at: string | null;
  created_at: string;
}

export interface ShareStateResponse {
  share: ShareSettings;
  invitations: NoteShareInvitation[];
  access?: NoteAccessState;
}

export interface ShareMutationResponse {
  share: ShareSettings;
  raw_token: string | null;
}

export interface RotateTokenResponse {
  share: ShareSettings;
  raw_token: string;
}

export interface CreateInvitationsResponse {
  created: NoteShareInvitation[];
  already_invited: string[];
  email_failed_ids: string[];
}

export interface AccessPrincipalSuggestion extends NoteAccessPrincipal {
  existing_grant_id: string | null;
}

export interface CreateAccessGrantInput {
  principal_type: NoteAccessPrincipal['type'];
  principal_id?: string;
  email?: string;
  permission: Exclude<NotePermission, 'owner'>;
}
