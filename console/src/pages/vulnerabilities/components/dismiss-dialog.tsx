import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { useVulnerabilitiesControllerBulkDismissVulnerabilities } from '@/services/apis/gen/queries';
import { addDays, format } from 'date-fns';
import { Loader2 } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  latestRiskExpiry,
  MAX_RISK_ACCEPTANCE_DAYS,
  RISK_DATE_FORMAT,
  riskExpiryAt,
} from '../risk-expiry';

/** Available reasons for dismissing a vulnerability */
const DISMISS_REASONS = [
  {
    value: 'false_positive',
    label: 'False positive',
    description: 'This alert is not valid',
  },
  {
    value: 'used_in_test',
    label: 'Used in tests',
    description: 'This alert is not in production code',
  },
  {
    value: 'wont_fix',
    label: "Won't fix",
    description: 'This alert is not relevant',
  },
  {
    value: 'risk_accepted',
    label: 'Risk accepted',
    description: 'Dismiss this alert until a date',
  },
] as const;

type DismissReason = (typeof DISMISS_REASONS)[number]['value'];

interface DismissAlertDialogProps {
  /** Multiple vulnerability IDs for bulk dismiss */
  vulnerabilityIds: string[];
  /** Display name for the vulnerability(s) being dismissed */
  vulnerabilityName?: string;
  /** Trigger element that opens the dialog */
  trigger: ReactNode;
  /** Callback invoked after successful dismissal */
  onDismissSuccess?: () => void;
}

/**
 * Renders a dialog for dismissing vulnerabilities with reason selection and optional comment.
 * Supports both single and bulk dismissal using the bulk dismiss API.
 */
export function DismissAlertDialog({
  vulnerabilityIds,
  vulnerabilityName,
  trigger,
  onDismissSuccess,
}: DismissAlertDialogProps) {
  const [open, setOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [reason, setReason] = useState<DismissReason | ''>('');
  const [comment, setComment] = useState('');
  const [expiry, setExpiry] = useState('');
  const expiryId = useId();

  const bulkDismissMutation =
    useVulnerabilitiesControllerBulkDismissVulnerabilities();

  const isBulkDismiss = selectedIds.length > 1;
  const isRisk = reason === 'risk_accepted';
  const now = new Date();
  const selectedExpiry = isRisk ? riskExpiryAt(expiry, now) : null;
  const invalidExpiry = isRisk && Boolean(expiry) && !selectedExpiry;

  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen);
    setSelectedIds(isOpen ? [...vulnerabilityIds] : []);
    if (!isOpen) {
      setReason('');
      setComment('');
      setExpiry('');
    }
  };

  /**
   * Handles the dismiss action by calling the bulk dismiss API.
   * Shows success/error toast based on the result.
   */
  const handleDismiss = () => {
    if (!reason || selectedIds.length === 0) return;
    const expiresAt = isRisk ? riskExpiryAt(expiry) : null;
    if (isRisk && !expiresAt) {
      toast.error('Choose a future expiry date within 180 days.');
      return;
    }

    bulkDismissMutation.mutate(
      {
        data: {
          ids: selectedIds,
          reason,
          comment: comment.trim(),
          ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
        },
      },
      {
        onSuccess: () => {
          toast.success(
            expiresAt
              ? 'Risk accepted'
              : isBulkDismiss
                ? 'Alerts dismissed'
                : 'Alert dismissed',
            {
              description: expiresAt
                ? `Acceptance ends on ${format(expiresAt, 'MMM d, yyyy')}.`
                : isBulkDismiss
                  ? `${selectedIds.length} vulnerabilities have been dismissed.`
                  : vulnerabilityName
                    ? `"${vulnerabilityName}" has been dismissed.`
                    : 'The vulnerability has been dismissed.',
            },
          );
          handleOpenChange(false);
          onDismissSuccess?.();
        },
        onError: (error) => {
          toast.error('Failed to dismiss alert(s)', {
            description:
              error instanceof Error
                ? error.message
                : 'An unexpected error occurred.',
          });
        },
      },
    );
  };

  const isSubmitDisabled =
    !reason ||
    selectedIds.length === 0 ||
    (isRisk && !selectedExpiry) ||
    bulkDismissMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Dismiss alert</DialogTitle>
          <DialogDescription>
            Select a reason to dismiss this alert.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Reason selection radio group */}
          <RadioGroup
            value={reason}
            onValueChange={(value) => {
              setReason(value as DismissReason);
              if (value !== 'risk_accepted') setExpiry('');
            }}
            className="space-y-3"
          >
            {DISMISS_REASONS.map((option) => (
              <div key={option.value} className="flex items-start space-x-3">
                <RadioGroupItem
                  value={option.value}
                  id={`reason-${option.value}`}
                  className="mt-0.5"
                />
                <div className="grid gap-0.5">
                  <Label
                    htmlFor={`reason-${option.value}`}
                    className="cursor-pointer font-medium"
                  >
                    {option.label}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {option.description}
                  </p>
                </div>
              </div>
            ))}
          </RadioGroup>

          {isRisk && (
            <div className="space-y-2">
              <Label htmlFor={expiryId}>Accepted until</Label>
              <Input
                id={expiryId}
                type="date"
                required
                value={expiry}
                min={format(addDays(now, 1), RISK_DATE_FORMAT)}
                max={format(latestRiskExpiry(now), RISK_DATE_FORMAT)}
                onChange={(event) => setExpiry(event.target.value)}
                aria-invalid={invalidExpiry}
                aria-describedby={`${expiryId}-hint`}
              />
              <p
                id={`${expiryId}-hint`}
                role={invalidExpiry ? 'alert' : undefined}
                className={
                  invalidExpiry
                    ? 'text-sm text-destructive'
                    : 'text-sm text-muted-foreground'
                }
              >
                {invalidExpiry
                  ? `Choose a future date within ${MAX_RISK_ACCEPTANCE_DAYS} days.`
                  : 'The alert reopens at the start of this date in your local timezone.'}
              </p>
            </div>
          )}

          {/* Optional comment field */}
          <div className="space-y-2">
            <Label htmlFor="dismiss-comment">Comment</Label>
            <Textarea
              id="dismiss-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Add a comment"
              className="resize-none"
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={bulkDismissMutation.isPending}
          >
            Cancel
          </Button>
          <Button onClick={handleDismiss} disabled={isSubmitDisabled}>
            {bulkDismissMutation.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Dismiss
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
