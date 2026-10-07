// ============================================================================
// Custom authentication and authorization (auth spec "Data model")
// Own identity store: users, roles, permissions, assignments, attributes,
// refresh-token hashes and the security audit trail. No XSUAA / IAS.
// ============================================================================
using { cuid, managed } from '@sap/cds/common';

namespace auth;

@title: '{i18n>AuthUsers_Entity}'
entity Users : cuid, managed {
  @title: '{i18n>Username}'           username           : String(60) not null;   // trimmed, lower-case, immutable
  @title: '{i18n>Email}'              email              : String(255);
  @title: '{i18n>PasswordHash}'       passwordHash       : String(255);           // scrypt$N$r$p$salt$hash, never plaintext
  @title: '{i18n>IsActive}'           isActive           : Boolean default true;  // users are never hard-deleted
  @title: '{i18n>MustChangePassword}' mustChangePassword : Boolean default false;
  @title: '{i18n>FailedLogins}'       failedLogins       : Integer default 0;
  @title: '{i18n>LockedUntil}'        lockedUntil        : Timestamp;
  @title: '{i18n>LastLoginAt}'        lastLoginAt        : Timestamp;
  @title: '{i18n>PasswordChangedAt}'  passwordChangedAt  : Timestamp;
  @title: '{i18n>TokenVersion}'       tokenVersion       : Integer default 0;     // bumped to revoke every token of the user
  @title: '{i18n>AuthRoles_Entity}'      roles      : Composition of many UserRoles on roles.user = $self;
  @title: '{i18n>AuthAttributes_Entity}' attributes : Composition of many UserAttributes on attributes.user = $self;
}
annotate Users with @assert.unique: { username: [username] };

@title: '{i18n>AuthRole_Entity}'
entity Roles : managed {
  key ID          : String(60) @title: '{i18n>RoleId}';
  @title: '{i18n>Description}' description : String(255);
  @title: '{i18n>Permissions_Entity}' permissions : Composition of many RolePermissions on permissions.role = $self;
}

// Defined by code, seeded via CSV, read-only at runtime
@title: '{i18n>Permissions_Entity}'
entity Permissions {
  key ID          : String(100) @title: '{i18n>PermissionId}';
  @title: '{i18n>Description}' description : String(255);
}

@title: '{i18n>RolePermissions_Entity}'
entity RolePermissions {
  key role       : Association to Roles       @title: '{i18n>AuthRole_Entity}';
  key permission : Association to Permissions @title: '{i18n>PermissionId}';
}

// Time-bound role assignment; only assignments inside their window count
@title: '{i18n>AuthRoles_Entity}'
entity UserRoles : managed {
  key user      : Association to Users @title: '{i18n>Username}';
  key role      : Association to Roles @title: '{i18n>AuthRole_Entity}';
  @title: '{i18n>ValidFrom}' validFrom : Timestamp;
  @title: '{i18n>ValidTo}'   validTo   : Timestamp;
}

// ABAC: several rows with the same name form a multi-valued attribute
@title: '{i18n>AuthAttributes_Entity}'
entity UserAttributes : cuid {
  @title: '{i18n>Username}'       user  : Association to Users not null;
  @title: '{i18n>AttributeName}'  name  : String(60) not null;
  @title: '{i18n>AttributeValue}' value : String(255);
}

// Only SHA-256 hashes of refresh tokens are stored, never the raw token
@title: '{i18n>RefreshTokens_Entity}'
entity RefreshTokens : cuid {
  @title: '{i18n>Username}'         user             : Association to Users not null;
  @title: '{i18n>TokenHash}'        tokenHash        : String(64) not null;
  @title: '{i18n>TokenFamily}'      family           : UUID not null;
  @title: '{i18n>ExpiresAt}'        expiresAt        : Timestamp not null;
  @title: '{i18n>SessionExpiresAt}' sessionExpiresAt : Timestamp not null;
  @title: '{i18n>RevokedAt}'        revokedAt        : Timestamp;
  @title: '{i18n>ReplacedBy}'       replacedBy       : UUID;
  @title: '{i18n>CreatedAt}'        createdAt        : Timestamp @cds.on.insert: $now;
  @title: '{i18n>CreatedIp}'        createdIp        : String(64);
  @title: '{i18n>UserAgent}'        userAgent        : String(255);
}
annotate RefreshTokens with @assert.unique: { tokenHash: [tokenHash] };

// Append-only security audit trail
@title: '{i18n>AuthAuditLog_Entity}'
entity AuditLog : cuid {
  @title: '{i18n>Timestamp}' timestamp : Timestamp @cds.on.insert: $now;
  @title: '{i18n>AuditEvent}' event    : String(40) not null;
  @title: '{i18n>UserId}'    userId    : UUID;
  @title: '{i18n>Username}'  username  : String(60);
  @title: '{i18n>ClientIp}'  ip        : String(64);
  @title: '{i18n>Success}'   success   : Boolean;
  @title: '{i18n>Details}'   details   : LargeString;   // JSON
}
