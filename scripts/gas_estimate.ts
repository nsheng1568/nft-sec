import Web3 from 'web3'
import { Contract } from 'web3-eth-contract'

const web3 = new Web3(web3Provider)

const libraries = {}

const MISC_ACC = 0
const NFTFI_ACC = 1
const BORROWER1_ACC = 2
const BORROWER2_ACC = 3
const STRUCTURER_ACC = 4
const INVESTOR1_ACC = 5
const INVESTOR2_ACC = 6
const INVESTOR3_ACC = 7
const INVESTOR4_ACC = 8
const INVESTOR5_ACC = 9
const LIQUIDATOR_ACC = 10

const TEN_ETH = '10000000000000000000';
const TWENTY_ETH = '20000000000000000000';
const FORTY_ETH = '40000000000000000000';
const EIGHTY_ETH = '80000000000000000000';
const ADMIN_FEE = 500 // 500 bps, the current NFTfi admin fee
const CHAINID = 1;

interface Contracts {
    bayc: Contract,
    weth: Contract,
    nftfi: Contract,
    nftfiLoanCoord: Contract,
    nftfiPromNote: Contract,
    nftSec: Contract,
}

interface Accounts {
    misc: string,
    nftfi: string,
    borrower1: string,
    borrower2: string,
    structurer: string,
    investor1: string,
    investor2: string,
    investor3: string,
    investor4: string,
    investor5: string,
    liquidator: string,
}

// #region Helper methods

/* Get Remix-provided account address for the given index */
const getAccount = async (accountIndex: number): Promise<string> => {
    const accounts = await web3.eth.getAccounts()
    return accounts[accountIndex]
}

/* Deploy library contract and save its metadata globally for linking into top-level contracts */
const deployLibrary = async (
    libraryPath: string,
    libraryName: string,
    account: string,
): Promise<void> => {
    const artifactsPath = `browser/${libraryPath}/artifacts/${libraryName}.json`
    const metadata = JSON.parse(await remix.call('fileManager', 'getFile', artifactsPath))
    const contract = await (new web3.eth.Contract(metadata.abi))
        .deploy({data: metadata.data.bytecode.object})
        .send({from: account, gas: 10**9})
    const libraryFile = `${libraryPath}/${libraryName}.sol`
    libraries[libraryFile] = {}
    libraries[libraryFile][libraryName] = contract.options.address
}

/* Deploy contract with the given arguments and return it */
const deploy = async (
    contractName: string,
    args: Array<any>,
    account: string,
): Promise<Contract> => {
    const artifactsPath = `browser/contracts/artifacts/${contractName}.json`
    const metadata = JSON.parse(await remix.call('fileManager', 'getFile', artifactsPath))
    let bytecode = metadata.data.bytecode.object
    const linkReferences = metadata.data.bytecode.linkReferences
    for (let libraryFile in linkReferences) {
        const fileReferences = linkReferences[libraryFile]
        for (let libraryName in fileReferences) {
            const occurrences = fileReferences[libraryName]
            for (let i = 0; i < occurrences.length; i++) {
                // Link previously deployed libraries by replacing placeholders in the compiled bytecode
                bytecode = (
                    bytecode.substring(0, 2 * occurrences[i].start)
                    + libraries[libraryFile][libraryName].substring(2)
                    + bytecode.substring(2 * occurrences[i].start + 40)
                )
            }
        }
    }
    const contract = await (new web3.eth.Contract(metadata.abi))
        .deploy({data: bytecode, arguments: args})
        .send({from: account, gas: 10**9})
    return contract
}

// #region Initializing contracts

/* Deploy BoredApeYachtClub contract and have the two borrowers each buy one */
const initBayc = async (accounts: Accounts): Promise<Contract> => {
    const bayc = await deploy('BoredApeYachtClub', ['BoredApeYachtClub', 'BAYC', 10000, 0], accounts.misc)
    await bayc.methods.flipSaleState().send({from: accounts.misc}) // Begin sale of apes

    // Borrowers buy apes
    await Promise.all([
        bayc.methods.mintApe(20).send({from: accounts.borrower1, value: TWENTY_ETH}),
        bayc.methods.mintApe(20).send({from: accounts.borrower1, value: TWENTY_ETH}),
        bayc.methods.mintApe(20).send({from: accounts.borrower1, value: TWENTY_ETH}),
        bayc.methods.mintApe(20).send({from: accounts.borrower1, value: TWENTY_ETH}),
    ])

    return bayc
}

/* Deploy wETH contract */
const initWeth = async (accounts: Accounts): Promise<Contract> => {
    return deploy('WETH9', [], accounts.misc)
}

/* Deploy NFTfi libraries */
const initNftfiLibs = async (accounts: Accounts): Promise<void> => {
    await Promise.all([
        deployLibrary('contracts/loans/direct/loanTypes', 'LoanAirdropUtils', accounts.nftfi),
        deployLibrary('contracts/loans/direct/loanTypes', 'LoanChecksAndCalculations', accounts.nftfi),
        deployLibrary('contracts/utils', 'ContractKeys', accounts.nftfi),
        deployLibrary('contracts/utils', 'NFTfiSigningUtils', accounts.nftfi),
    ])
}

/* Deploy NFTfi hub for keeping track of NFTfi-related contracts */
const initNftfiHub = async (accounts: Accounts): Promise<Contract> => {
    return deploy('NftfiHub', [accounts.nftfi, [], []], accounts.nftfi)
}

/* Deploy NFTfi ERC721 wrapper contract for abstracting collateral transactions */
const initNftfiErc721Wrapper = async(accounts: Accounts): Promise<Contract> => {
    return deploy('ERC721Wrapper', [], accounts.nftfi)
}

/* Deploy NFTfi Permitted NFTs contract for registering collection permissions, and track it in the hub */
const initNftfiPermNfts = async (
    nftfiErc721Wrapper: Contract,
    nftfiHub: Contract,
    bayc: Contract,
    accounts: Accounts,
): Promise<void> => {
    const nftfiPermNfts = await deploy(
        'PermittedNFTsAndTypeRegistry',
        [
            accounts.nftfi,
            nftfiHub.options.address,
            ['BoredApeYachtClub'],
            [nftfiErc721Wrapper.options.address],
            [bayc.options.address],
            ['BoredApeYachtClub'],
        ],
        accounts.nftfi,
    )
    await nftfiHub.methods.setContract('PERMITTED_NFTS', nftfiPermNfts.options.address).send({from: accounts.nftfi})
}

/**
 * Deploy NFTfi Direct Loan Coordinator contract for registering loans, and track it in the hub.
 * Also, deploy SmartNft contracts representing the Promissory Note and Obligation Record, and initialize them
 * in the loan coordinator.
 */
const initNftfiLoanCoord = async (
    nftfiHub: Contract,
    nftfi: Contract,
    accounts: Accounts,
): Promise<[Contract, Contract]> => {
    const nftfiLoanCoord = await deploy(
        'DirectLoanCoordinator',
        [
            nftfiHub.options.address,
            accounts.nftfi,
            ['DIRECT_LOAN_FIXED_REDEPLOY'],
            [nftfi.options.address],
        ],
        accounts.nftfi,
    )
    const [nftfiPromNote, nftfiObliNote] = await Promise.all([
        deploy(
            'SmartNft',
            [
                accounts.nftfi,
                nftfiHub.options.address,
                nftfiLoanCoord.options.address,
                'NFTfi Promissory Note',
                'PNNFI',
                'https://metadata.nftfi.com/loans/v2/promissory/1/',
            ],
            accounts.nftfi,
        ),
        deploy(
            'SmartNft',
            [
                accounts.nftfi,
                nftfiHub.options.address,
                nftfiLoanCoord.options.address,
                'NFTfi Obligation Receipt',
                'ORNFI',
                'https://metadata.nftfi.com/loans/v2/obligation/1/',
            ],
            accounts.nftfi,
        ),
    ])
    await Promise.all([
        nftfiLoanCoord.methods.initialize(nftfiPromNote.options.address, nftfiObliNote.options.address).send({from: accounts.nftfi}),
        nftfiHub.methods.setContract('DIRECT_LOAN_COORDINATOR', nftfiLoanCoord.options.address).send({from: accounts.nftfi}),
    ])
    return [nftfiLoanCoord, nftfiPromNote]
}

/* Deploy Direct Loan contract, which is the main entry point for NFTfi interactions, and set its admin fee */
const initNiftfi = async (
    nftfiHub: Contract,
    weth: Contract,
    accounts: Accounts,
): Promise<Contract> => {
    const nftfi = await deploy('DirectLoanFixedOfferRedeploy', [accounts.nftfi, nftfiHub.options.address, [weth.options.address]], accounts.nftfi)
    await nftfi.methods.updateAdminFee(ADMIN_FEE).send({from: accounts.nftfi})
    return nftfi
}

/* Deploy NftSec contract, containing our securitized product logic */
const initNftSec = async (
    weth: Contract,
    nftfi: Contract,
    nftfiHub: Contract,
    nftfiErc721Wrapper: Contract,
    nftfiPermNote: Contract,
    accounts: Accounts
): Promise<Contract> => {
    return deploy(
        'NftSec',
        [
            weth.options.address,
            nftfi.options.address,
            nftfiHub.options.address,
            nftfiErc721Wrapper.options.address,
            nftfiPermNote.options.address,
            4,
            1,
        ],
        accounts.misc,
    )
}

/* Initialize all contracts and return a bundle of them for future use */
const init = async (accounts: Accounts): Promise<Contracts> => {
    console.log('\nStep 0: Initializing contracts...')
    await initNftfiLibs(accounts)
    const [bayc, weth, nftfiHub, nftfiErc721Wrapper] = await Promise.all([
        initBayc(accounts),
        initWeth(accounts),
        initNftfiHub(accounts),
        initNftfiErc721Wrapper(accounts),
    ])
    const nftfi = await initNiftfi(nftfiHub, weth, accounts)
    const [[nftfiLoanCoord, nftfiPromNote],] = await Promise.all([
        initNftfiLoanCoord(nftfiHub, nftfi, accounts),
        initNftfiPermNfts(nftfiErc721Wrapper, nftfiHub, bayc, accounts),
    ])
    const nftSec = await initNftSec(
        weth,
        nftfi,
        nftfiHub,
        nftfiErc721Wrapper,
        nftfiPromNote,
        accounts,
    )
    return {
        bayc: bayc,
        weth: weth,
        nftfi: nftfi,
        nftfiLoanCoord: nftfiLoanCoord,
        nftfiPromNote: nftfiPromNote,
        nftSec: nftSec,
    }
}

// #region Sourcing loans

/* Sign and accept an offer to initiate a loan on NFTfi */
const acceptOffer = async (
    contracts: Contracts,
    loanPrincipalAmount: string,
    maximumRepaymentAmount: string,
    nftCollateralId: number,
    loanDuration: number,
    nonce: number,
    structurerAcc: string,
    borrowerAcc: string,
): Promise<void> => {
    const referrer = '0x0000000000000000000000000000000000000000' // no referrer
    const expiry = 2 * 10**9 // expiry far in the future
    const data = web3.utils.soliditySha3(
        {t: 'address', v: contracts.weth.options.address},
        {t: 'uint256', v: loanPrincipalAmount},
        {t: 'uint256', v: maximumRepaymentAmount},
        {t: 'address', v: contracts.bayc.options.address},
        {t: 'uint256', v: nftCollateralId},
        {t: 'address', v: referrer},
        {t: 'uint32', v: loanDuration},
        {t: 'uint16', v: ADMIN_FEE},
        {t: 'address', v: structurerAcc},
        {t: 'uint256', v: nonce},
        {t: 'uint256', v: expiry},
        {t: 'address', v: contracts.nftfi.options.address},
        {t: 'uint256', v: CHAINID},
    )
    const [signature,] = await Promise.all([
        web3.eth.sign(data, structurerAcc), // structurer signs the offer
        contracts.bayc.methods.approve(contracts.nftfi.options.address, nftCollateralId).send({from: borrowerAcc}), // borrower approves NFT transfer
    ])
    await contracts.nftfi.methods.acceptOffer(
        [
            loanPrincipalAmount,
            maximumRepaymentAmount,
            nftCollateralId,
            contracts.bayc.options.address,
            loanDuration,
            ADMIN_FEE,
            contracts.weth.options.address,
            referrer,
        ],
        [
            nonce,
            expiry,
            structurerAcc,
            signature,
        ],
        [
            referrer,
            0,
        ]
    ).send({from: borrowerAcc})
}

/* Obtain wETH for account by depositing ETH */
const obtainWeth = async (contracts: Contracts, amount: string, account: string): Promise<void> => {
    await contracts.weth.methods.deposit().send({from: account, value: amount})
}

/* Approve transfer of wETH to NFTfi from account */
const approveWethToNftfi = async (contracts: Contracts, amount: string, account: string): Promise<void> => {
    await contracts.weth.methods.approve(contracts.nftfi.options.address, amount).send({from: account})
}

/* Initiate two NFTfi loans between structurer and borrowers */
const initiateLoans = async (contracts: Contracts, accounts: Accounts): Promise<void> => {
    console.log('\nStep 1: Initiating NFTfi loans...')
    await Promise.all([
        obtainWeth(contracts, EIGHTY_ETH, accounts.structurer), // Obtain 80 wETH
        approveWethToNftfi(contracts, EIGHTY_ETH, accounts.structurer) // Approve transfer of 80 wETH
    ])

    // Initiate NFTfi loans
    await Promise.all(Array.from({length: 80}, (_, i) => acceptOffer(
        contracts,
        '1000000000000000000', // 1 ETH principal
        '1050000000000000000', // 1.05 ETH principal ==> 5% interest, not annualized
        i,
        25,
        i,
        accounts.structurer,
        accounts.borrower1,
    )))
}

// #region Minting tokens

/* Mint tranche tokens by sending NFTfi Promissory Notes to NftSec */
const mintTranches = async (contracts: Contracts, accounts: Accounts): Promise<void> => {
    console.log('\nStep 2: Minting tranche tokens...')
    // Send NFTfi Promissory Notes
    const approvePromNote = () => 
        contracts.nftfiPromNote.methods.setApprovalForAll(contracts.nftSec.options.address, true)
    console.log(
        'NFTfi Promissory Note approval gas cost:',
        await approvePromNote().estimateGas({from: accounts.structurer}),
    )
    await approvePromNote().send({from: accounts.structurer})

    const mintTrancheTokens = () => contracts.nftSec.methods.mint(
        [25, 42, 58], // annualized interest rates of 3%, 5%, 7%, quoted here in monthly bps
        [TWENTY_ETH, TWENTY_ETH, FORTY_ETH],
        Array.from({length: 80}, (_, i) => i + 1),
        35,
        '100000000000000000', // residual price of 0.1 ETH
    )
    console.log(
        'NftSec tranche token minting gas cost:',
        await mintTrancheTokens().estimateGas({from: accounts.structurer})
    )
    // Mint tranche tokens
    await mintTrancheTokens().send({from: accounts.structurer, gas: 10**9})
}

// #region Investing in tranches

/* Approve transfer of wETH to NFTfi from account */
const approveWethToNftSec = async (contracts: Contracts, amount: string, account: string): Promise<void> => {
    await contracts.weth.methods.approve(contracts.nftSec.options.address, amount).send({from: account})
}

/* Investors invest in the various tranche tokens by paying wETH */
const investInTranches = async (contracts: Contracts, accounts: Accounts): Promise<void> => {
    console.log('\nStep 3: Investing in tranche tokens...')

    // Obtain and approve transfer of 20 wETH for each investor
    await Promise.all([
        obtainWeth(contracts, EIGHTY_ETH, accounts.investor1),
        obtainWeth(contracts, EIGHTY_ETH, accounts.investor2),
        obtainWeth(contracts, EIGHTY_ETH, accounts.investor3),
        obtainWeth(contracts, EIGHTY_ETH, accounts.investor4),
        approveWethToNftSec(contracts, EIGHTY_ETH, accounts.investor1),
        approveWethToNftSec(contracts, EIGHTY_ETH, accounts.investor2),
        approveWethToNftSec(contracts, EIGHTY_ETH, accounts.investor3),
        approveWethToNftSec(contracts, EIGHTY_ETH, accounts.investor4),
    ])

    console.log(
        'Senior tranche token purchase gas cost:',
        await contracts.nftSec.methods.buyTokens(0, 0, TWENTY_ETH).estimateGas({from: accounts.investor1}),
        'Residual tranche token purchase gas cost:',
        await contracts.nftSec.methods.buyResidual(0).estimateGas({from: accounts.investor4}),
    )

    await Promise.all([
        contracts.nftSec.methods.buyTokens(0, 0, TWENTY_ETH).send({from: accounts.investor1}), // Investor 1 purchases senior tranche
        contracts.nftSec.methods.buyTokens(0, 1, TWENTY_ETH).send({from: accounts.investor2}), // Investor 2 purchases mezz tranche
        contracts.nftSec.methods.buyTokens(0, 2, TWENTY_ETH).send({from: accounts.investor3}), // Investor 3 purchases junior tranche
        contracts.nftSec.methods.buyResidual(0).send({from: accounts.investor4}), // Investor 4 purchases non-fungible resudiual tranche
    ])
}

// #region Repaying loans

/* First borrower repays her loan to the structurer in wETH */
const repayLoan = async (contracts: Contracts, accounts: Accounts): Promise<void> => {
    console.log('\nStep 4: Repaying loan...')

    await Promise.all([
        obtainWeth(contracts, TEN_ETH, accounts.borrower1), // Obtain more ETH for the borrower
        approveWethToNftfi(contracts, EIGHTY_ETH, accounts.borrower1) // Approve transfer of repayment amount to NFTfi
    ])

    await Promise.all(Array.from({length: 70}, (_, i) => contracts.nftfi.methods.payBackLoan(i + 1).send({from: accounts.borrower1})))
}

// #region Liquidating collateral

/* Liquidator seizes NFT collateral for second loan which was not repaid in time */
const liquidateNft = async (contracts: Contracts, accounts: Accounts): Promise<void> => {
    console.log('\nStep 5: Liquidating collateral...')

    await Promise.all([
        obtainWeth(contracts, EIGHTY_ETH, accounts.liquidator),
        approveWethToNftSec(contracts, EIGHTY_ETH, accounts.liquidator),
    ])

    await new Promise(r => setTimeout(r, 16000))
    console.log(
        'NFT liquidation gas cost:',
        await contracts.nftSec.methods.liquidateNft(contracts.bayc.options.address, 70).estimateGas({from: accounts.liquidator}),
    )
    await Promise.all(Array.from({length: 10}, (_, i) =>
        contracts.nftSec.methods.liquidateNft(contracts.bayc.options.address, i + 70).send({from: accounts.liquidator})))
}

// #region Transferring tranche tokens

/* Investors buy and sell tranche tokens on secondary market */
const transactTranches = async (contracts: Contracts, accounts: Accounts): Promise<void> => {
    console.log('\nStep 6: Transacting fungible tokens...')
}

// #region Redeeming tranche tokens

/* All investors redeem their tranche tokens and receive wETH in return */
const redeemTranches = async (contracts: Contracts, accounts: Accounts): Promise<void> => {
    console.log('\nStep 7: Redeeming tokens...')

    await new Promise(r => setTimeout(r, 15000))
    const redeemResidual = () => contracts.nftSec.methods.redeemTokens(0)
    console.log(
        'Residual tranche redemption gas cost:',
        await redeemResidual().estimateGas({from: accounts.investor4}),
    )
    await redeemResidual().send({from: accounts.investor4})

    const redeemTranche = () => contracts.nftSec.methods.redeemTokens(0)
    console.log(
        'Senior tranche token redemption gas cost:',
        await redeemTranche().estimateGas({from: accounts.investor1})
    )
    await redeemTranche().send({from: accounts.investor1})

    console.log(
        'Mezz tranche token redemption gas cost:',
        await redeemTranche().estimateGas({from: accounts.investor2})
    )
    await redeemTranche().send({from: accounts.investor2})

    console.log(
        'Junior tranche token redemption gas cost:',
        await redeemTranche().estimateGas({from: accounts.investor3})
    )
    await redeemTranche().send({from: accounts.investor3})
}

/* Main body of scenario test */
(async () => {
    try {
        const accounts: Accounts = await Promise.all([
            MISC_ACC,
            NFTFI_ACC,
            BORROWER1_ACC,
            BORROWER2_ACC,
            STRUCTURER_ACC,
            INVESTOR1_ACC,
            INVESTOR2_ACC,
            INVESTOR3_ACC,
            INVESTOR4_ACC,
            INVESTOR5_ACC,
            LIQUIDATOR_ACC,
        ].map(getAccount)).then(result => { return {
            misc: result[0],
            nftfi: result[1],
            borrower1: result[2],
            borrower2: result[3],
            structurer: result[4],
            investor1: result[5],
            investor2: result[6],
            investor3: result[7],
            investor4: result[8],
            investor5: result[9],
            liquidator: result[10],
        }})

        const contracts = await init(accounts)
        await initiateLoans(contracts, accounts)
        await mintTranches(contracts, accounts)
        await investInTranches(contracts, accounts)
        await repayLoan(contracts, accounts)
        await liquidateNft(contracts, accounts)
        await transactTranches(contracts, accounts)
        await redeemTranches(contracts, accounts)
        console.log('\nEnd of test.')
    } catch (e) {
        console.error(e.message)
    }
})()