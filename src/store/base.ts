export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export const errStatus = (status: number, message: string) =>
  new HttpError(status, message);

export type Wallet = {
  id: string;
  owner_token: string;
  balance_paise: number;
};

export type TransferStatus = "completed" | "declined";

export type Transfer = {
  id: string;
  idempotency_key: string;
  from_wallet_id: string;
  to_wallet_id: string;
  amount_paise: number;
  status: TransferStatus;
  reversal_of_id: string | null;
};

export type TransferWithOwners = Transfer & {
  from_owner: string;
  to_owner: string;
};

export interface Store {
  init(): Promise<void>;
  getOrCreateWallet(owner: string): Promise<Wallet>;
  getWallet(id: string): Promise<Wallet | undefined>;
  getTransfer(id: string): Promise<Transfer | undefined>;
  getTransferWithOwners(id: string): Promise<TransferWithOwners | undefined>;
  transfer(
    owner: string,
    from: string,
    to: string,
    amount: number,
    key: string,
    correlationId: string,
  ): Promise<Transfer>;
  reverse(
    owner: string,
    originalId: string,
    key: string,
    correlationId: string,
  ): Promise<Transfer>;
}

export const isUniqueViolationPg = (e: unknown) =>
  typeof e === "object" &&
  e !== null &&
  "code" in e &&
  (e as { code?: unknown }).code === "23505";

export const isInvalidUuidPg = (e: unknown) =>
  typeof e === "object" &&
  e !== null &&
  "code" in e &&
  (e as { code?: unknown }).code === "22P02";