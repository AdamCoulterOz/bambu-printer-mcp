/** Independent X.509 boundary. Path, constraints, signatures and CRLs are checked
 * by OpenSSL 3+, never by treating Node's X509Certificate parser as a verifier.
 * App trust ends at the fixed directly issuing CA; its upstream revocation is
 * deliberately not claimed. Device trust is a separate operator supplied CA.
 */
import { X509Certificate, type KeyObject } from 'node:crypto';
export declare const APP_CA_SHA256 = "0569df45e97c9e5b3ea1eaa0c73b0d1f65f33579f1542870ec5845a134747978";
export declare class SigningError extends Error {
    readonly code: string;
    constructor(code: string);
}
export declare const fail: (code: string) => never;
export declare function pemBlocks(input: string, label: 'CERTIFICATE' | 'X509 CRL', maximum?: number): string[];
export declare function fingerprint(certificate: X509Certificate): string;
export declare function checkOpenSsl(): Promise<void>;
type Der = {
    tag: number;
    value: Buffer;
    raw: Buffer;
};
export declare function rfc4514(name: Der): string;
export declare function certificateId(certificate: X509Certificate): string;
export type AppMaterial = {
    privateKey: KeyObject;
    certId: string;
    chainPem: string;
    crlPem: string;
    notBefore: number;
    expiresAt: number;
};
/** Internal verifier accepts an explicit pin so synthetic PKI can exercise every
 * gate. The production factory always supplies APP_CA_SHA256, never user input. */
export declare function validateAppMaterial(keyPem: string, chainPem: string, crlPem: string, now: number, expectedPin: string): Promise<AppMaterial>;
export declare function validateDeviceTrust(trustPem: string): void;
export type DeviceMaterial = {
    publicKey: KeyObject;
    notBefore: number;
    expiresAt: number;
};
export declare function validateDeviceMaterial(chainPem: string, trustPem: string, serial: string, now: number): Promise<DeviceMaterial>;
export {};
