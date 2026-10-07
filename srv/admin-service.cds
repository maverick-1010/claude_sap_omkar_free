using { auth } from '../db/auth-schema';

// User, role, attribute and session administration of the custom auth framework (auth spec "Admin service").
// Not to be confused with MaterialAdminService (S/4 configuration). Requires the User.Admin permission.
@path: '/admin'
@requires: 'User.Admin'
service AuthAdminService {

  // No hash, token version or failure counter. Created only by createUser, never deleted (deactivate instead).
  entity Users as projection on auth.Users excluding { passwordHash, tokenVersion, failedLogins };
  annotate Users with {
    username           @readonly;
    lockedUntil        @readonly;
    lastLoginAt        @readonly;
    passwordChangedAt  @readonly;
    mustChangePassword @readonly;
  };

  entity UserRoles       as projection on auth.UserRoles;
  entity UserAttributes  as projection on auth.UserAttributes;
  entity Roles           as projection on auth.Roles;
  entity RolePermissions as projection on auth.RolePermissions;

  @readonly entity Permissions as projection on auth.Permissions;
  @readonly entity AuditLog    as projection on auth.AuditLog;

  // Open sessions (refresh-token families), never the token hash
  @readonly entity Sessions as projection on auth.RefreshTokens {
    ID, user, family, expiresAt, sessionExpiresAt, createdAt, createdIp, userAgent
  } where revokedAt is null;

  action createUser(username : String(60), email : String(255), password : String, roles : many String(60))
    returns { ID : UUID; username : String(60) };
  action resetPassword(userId : UUID, newPassword : String);
  action unlockUser(userId : UUID);
  action revokeSessions(userId : UUID);
}
