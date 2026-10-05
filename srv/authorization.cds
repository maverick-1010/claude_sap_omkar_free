using { MassMaterialService as MMS, MaterialAdminService } from './mass-material-service';
using from './material-admin-service';

// Authorization (spec §5). Row filtering lives here, never in handler code (§5.3).

annotate MMS.UploadJobs with @restrict: [
  { grant: ['READ','CREATE','UPDATE','DELETE','parse','validate','submit',
            'cancel','retryFailed','downloadResult'],
    to: 'MaterialRequester', where: 'createdBy = $user' },
  { grant: ['READ','approve','reject','downloadResult'],
    to: 'MaterialApprover', where: 'status <> ''DRAFT''' },
  { grant: '*', to: 'MaterialAdmin' }
];

annotate MMS.JobFiles with @restrict: [
  { grant: ['READ','CREATE','UPDATE'], to: 'MaterialRequester', where: 'job.createdBy = $user' },
  { grant: 'READ', to: 'MaterialApprover', where: 'job.status <> ''DRAFT''' },
  { grant: '*', to: 'MaterialAdmin' }
];

annotate MMS.MaterialRequests with @restrict: [
  { grant: ['READ','CREATE','UPDATE','DELETE'], to: 'MaterialRequester',
    where: 'job.createdBy = $user' },
  { grant: 'READ', to: 'MaterialApprover', where: 'job.status <> ''DRAFT''' },
  { grant: '*', to: 'MaterialAdmin' }
];

// Child views: same pattern, the path to the job goes through the request
annotate MMS.MaterialPlantData with @restrict: [
  { grant: ['READ','CREATE','UPDATE','DELETE'], to: 'MaterialRequester', where: 'request.job.createdBy = $user' },
  { grant: 'READ', to: 'MaterialApprover', where: 'request.job.status <> ''DRAFT''' },
  { grant: '*', to: 'MaterialAdmin' }
];
annotate MMS.MaterialStorageData with @restrict: [
  { grant: ['READ','CREATE','UPDATE','DELETE'], to: 'MaterialRequester', where: 'request.job.createdBy = $user' },
  { grant: 'READ', to: 'MaterialApprover', where: 'request.job.status <> ''DRAFT''' },
  { grant: '*', to: 'MaterialAdmin' }
];
annotate MMS.MaterialSalesData with @restrict: [
  { grant: ['READ','CREATE','UPDATE','DELETE'], to: 'MaterialRequester', where: 'request.job.createdBy = $user' },
  { grant: 'READ', to: 'MaterialApprover', where: 'request.job.status <> ''DRAFT''' },
  { grant: '*', to: 'MaterialAdmin' }
];
annotate MMS.MaterialValuationData with @restrict: [
  { grant: ['READ','CREATE','UPDATE','DELETE'], to: 'MaterialRequester', where: 'request.job.createdBy = $user' },
  { grant: 'READ', to: 'MaterialApprover', where: 'request.job.status <> ''DRAFT''' },
  { grant: '*', to: 'MaterialAdmin' }
];
annotate MMS.MaterialPurchasingData with @restrict: [
  { grant: ['READ','CREATE','UPDATE','DELETE'], to: 'MaterialRequester', where: 'request.job.createdBy = $user' },
  { grant: 'READ', to: 'MaterialApprover', where: 'request.job.status <> ''DRAFT''' },
  { grant: '*', to: 'MaterialAdmin' }
];
annotate MMS.ValidationMessages with @restrict: [
  { grant: 'READ', to: 'MaterialRequester', where: 'request.job.createdBy = $user' },
  { grant: 'READ', to: 'MaterialApprover', where: 'request.job.status <> ''DRAFT''' },
  { grant: '*', to: 'MaterialAdmin' }
];

// Reference data and template: any authenticated user
annotate MMS.ValueHelps        with @requires: 'authenticated-user';
annotate MMS.MaterialTypeViews with @requires: 'authenticated-user';
annotate MMS.getTemplate       with @requires: 'authenticated-user';

annotate MaterialAdminService with @requires: 'MaterialAdmin';
